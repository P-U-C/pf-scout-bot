#!/bin/bash
# check-heartbeats.sh
#
# Detects the silent bot-outage failure mode that went unnoticed for 15 days:
# a reboot wipes the /tmp heartbeat MCP configs, the pings fail quietly
# (stderr -> /dev/null), and lens/subs show "unavailable" while the processes
# look alive. This actively pings both bots, and if either is NOT status:active
# it alerts Chad on Telegram. Self-heals first by regenerating the /tmp configs
# (the usual root cause) before declaring a real outage.
#
# Alerts only on STATE CHANGE (healthy->stale and stale->recovered) so a genuine
# multi-day outage pings once, not every run. State persists outside /tmp so a
# reboot can't erase the memory of the last known state.
#
# Secrets (seeds, tokens) are never printed or logged.
set -uo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/home/ubuntu/pf-scout-bot/deploy}"
TG_ENV="${TG_ENV:-/home/ubuntu/.claude/channels/telegram/.env}"
STATE_FILE="${HEARTBEAT_STATE_FILE:-$DEPLOY_DIR/.heartbeat-state}"
export PATH="/home/ubuntu/.claude/local/bin:$PATH"

BOT_CFG=/tmp/register-bot-mcp.json
SUBS_CFG=/tmp/register-subs-mcp-fresh.json

# Self-heal: if the /tmp configs are missing (the reboot failure mode), rebuild
# them before we ping, so a transient wipe doesn't read as a real outage.
if [ ! -f "$BOT_CFG" ] || [ ! -f "$SUBS_CFG" ]; then
  bash "$DEPLOY_DIR/regen-mcp-configs.sh" >/dev/null 2>&1 || true
fi

# Ping one bot via its MCP config; echo "active" iff the ping tool reports so.
ping_status() {
  local cfg="$1"
  [ -f "$cfg" ] || { echo "noconfig"; return; }
  local out attempt
  # Retry up to 3x: each call cold-starts the npx MCP server and an occasional
  # first attempt returns empty. Only a real outage should read as "stale" — a
  # false alert is worse than none. The ping tool replies in prose/markdown,
  # e.g. 'Status **active**', so match 'status' ... 'active' on the line.
  for attempt in 1 2 3; do
    # Direct JSON-RPC, no model: this monitor was itself spending ~72 model
    # sessions a day to ask a question with no judgement in it. See ping-bot.sh
    # for the full accounting.
    #
    # Trust the exit status, not a regex over prose. mcp-call.py returns 0 only
    # when the tool reports success (it checks the MCP isError flag), so the
    # tool's own verdict decides -- where 'status.*active' was pattern-matching
    # whatever wording the model happened to relay that morning.
    if timeout -k 15 120 /home/ubuntu/scripts/mcp-call.py \
         --config "$cfg" --tool ping --timeout 100 >/dev/null 2>&1; then
      echo "active"; return
    fi
    sleep 5
  done
  echo "stale"
}

BOT_STATUS="$(ping_status "$BOT_CFG")"
SUBS_STATUS="$(ping_status "$SUBS_CFG")"

# Overall state: healthy only if BOTH are active.
if [ "$BOT_STATUS" = "active" ] && [ "$SUBS_STATUS" = "active" ]; then
  CURRENT="healthy"
else
  CURRENT="stale"
fi

PREV="$(cat "$STATE_FILE" 2>/dev/null || echo unknown)"
echo "$CURRENT" > "$STATE_FILE"

# Only message on a transition (or first-ever run that finds trouble).
notify() {
  local text="$1"
  [ -f "$TG_ENV" ] || return 0
  local token chat
  token="$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$TG_ENV" | cut -d= -f2-)"
  chat="$(grep -m1 '^TELEGRAM_CHAT_ID=' "$TG_ENV" | cut -d= -f2-)"
  [ -n "$token" ] && [ -n "$chat" ] || return 0
  curl -s -o /dev/null --max-time 20 \
    "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${chat}" \
    --data-urlencode "text=${text}" || true
}

# Alerting only on a transition is right for a flapping service and wrong for a
# broken one. The heartbeats have been failing for as long as this log exists;
# the state file latched at "stale", every later run compared stale to stale,
# and the monitor went quiet for months about a thing that was never fixed. A permanently-bad state that stops mentioning itself is the same
# failure as a green light on a dead pipeline, just wearing the opposite colour.
#
# So: still alert on every transition, and additionally re-state a persistent
# outage on a slow cadence. Slow enough not to become noise, often enough that
# "we forgot" is not how it ends.
REMIND_AFTER_DAYS="${HEARTBEAT_REMIND_AFTER_DAYS:-7}"
LAST_NOTIFY_FILE="$DEPLOY_DIR/.heartbeat-last-notify"

remind_due() {
  local last now
  last="$(cat "$LAST_NOTIFY_FILE" 2>/dev/null || echo 0)"
  case "$last" in (*[!0-9]*|"") last=0 ;; esac
  now="$(date +%s)"
  [ "$(( (now - last) / 86400 ))" -ge "$REMIND_AFTER_DAYS" ]
}

stamp_notify() { date +%s > "$LAST_NOTIFY_FILE"; }

if [ "$CURRENT" = "stale" ] && [ "$PREV" != "stale" ]; then
  notify "⚠️ Bot heartbeat check: lens=${BOT_STATUS}, subs=${SUBS_STATUS}. One or both bots are not reporting active. Auto-regen of /tmp configs already attempted. Check uptime -s for a reboot and run regen-mcp-configs.sh + a manual ping."
  stamp_notify
elif [ "$CURRENT" = "healthy" ] && [ "$PREV" = "stale" ]; then
  notify "✅ Bot heartbeats recovered: lens and subs are both active again."
  stamp_notify
elif [ "$CURRENT" = "stale" ] && remind_due; then
  notify "⚠️ Bot heartbeats still down (lens=${BOT_STATUS}, subs=${SUBS_STATUS}) — unchanged for ${REMIND_AFTER_DAYS}+ days, so this is a standing outage, not a blip. Diagnosed 2026-08-25: keystone-grpc.postfiat.org accepts TCP and then serves nothing — TLS closes with unexpected EOF, h2c resets, port 80 empty-replies — identically from two independent networks (this ISP over IPv4, Cloudflare over IPv6). postfiat.org itself is up, so it is that one service. This is upstream, not our config: nothing on this box can fix it, and the bots stay hidden from the registry until postfiat brings it back."
  stamp_notify
fi

echo "[$(date -u +%FT%TZ)] heartbeat check: lens=$BOT_STATUS subs=$SUBS_STATUS state=$CURRENT (prev=$PREV)"
