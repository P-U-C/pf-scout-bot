#!/bin/bash
# regen-mcp-configs.sh
#
# Rebuilds the heartbeat MCP configs that ping-bot.sh / ping-subs.sh need.
# These live in /tmp and are wiped on every reboot, which silently kills the
# bot/subs heartbeats (the bots then register as "unavailable" even though the
# processes are alive). Run on @reboot so a restart can never strand them again.
#
# Seeds are read from .env at runtime and never printed.
set -euo pipefail

ENV_FILE="${PF_SCOUT_ENV:-/home/ubuntu/pf-scout-bot/.env}"

read_val() { grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2-; }

BOT_SEED="$(read_val BOT_SEED)"
SUBS_SEED="$(read_val SUBS_SEED)"
BOT_KEYSTONE="$(read_val KEYSTONE_API_KEY)"
SUBS_KEYSTONE="$(read_val SUBS_KEYSTONE_API_KEY)"

if [ -z "$BOT_SEED" ] || [ -z "$SUBS_SEED" ] || [ -z "$BOT_KEYSTONE" ] || [ -z "$SUBS_KEYSTONE" ]; then
  echo "regen-mcp-configs: missing BOT_SEED/SUBS_SEED/KEYSTONE_API_KEY/SUBS_KEYSTONE_API_KEY in $ENV_FILE" >&2
  exit 1
fi

write_cfg() {
  # $1 = output path, $2 = seed value, $3 = keystone api key
  # The pft-chatbot-mcp server reads BOT_SEED + KEYSTONE_API_KEY from env; the
  # keystone key is sent as the x-api-key header (without it the ping tool
  # fails with "16 UNAUTHENTICATED: missing x-api-key header").
  umask 077
  cat > "$1" <<JSON
{
  "mcpServers": {
    "@postfiatorg/pft-chatbot-mcp": {
      "command": "npx",
      "args": ["@postfiatorg/pft-chatbot-mcp"],
      "env": {
        "BOT_SEED": "$2",
        "KEYSTONE_API_KEY": "$3"
      }
    }
  }
}
JSON
}

write_cfg /tmp/register-bot-mcp.json "$BOT_SEED" "$BOT_KEYSTONE"
write_cfg /tmp/register-subs-mcp-fresh.json "$SUBS_SEED" "$SUBS_KEYSTONE"

echo "regen-mcp-configs: wrote /tmp/register-bot-mcp.json and /tmp/register-subs-mcp-fresh.json"
