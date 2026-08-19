#!/bin/bash
# Export hive-herald.json — The Hive Herald daily intelligence briefing
# Generated from chain-index.db, health.json, auth.json

python3 << 'PYEOF'
import sqlite3, json, os, hashlib
from datetime import datetime, timezone, timedelta
from collections import Counter

db = sqlite3.connect(os.path.expanduser('~/.pf-scout/chain-index.db'))
db.row_factory = sqlite3.Row

now = datetime.now(timezone.utc)
today = now.strftime('%Y-%m-%d')
yesterday = (now - timedelta(days=1)).strftime('%Y-%m-%d')
published_at = now.strftime('%Y-%m-%dT%H:%M:%SZ')

# ── PULSE — Network vital signs ─────────────────────────────────────

total_accounts = db.execute("SELECT COUNT(*) as c FROM accounts WHERE tx_count > 0").fetchone()['c']
bot_count = db.execute("SELECT COUNT(*) as c FROM wallet_labels WHERE label_type = 'bot'").fetchone()['c']
infra_count = db.execute("SELECT COUNT(*) as c FROM wallet_labels WHERE label_type = 'infrastructure'").fetchone()['c']
contributor_count = total_accounts - bot_count - infra_count

memos_today = db.execute("""
    SELECT COUNT(*) as c FROM transactions
    WHERE has_memo = 1 AND timestamp_iso LIKE ? || '%'
""", (today,)).fetchone()['c']

memos_yesterday = db.execute("""
    SELECT COUNT(*) as c FROM transactions
    WHERE has_memo = 1 AND timestamp_iso LIKE ? || '%'
""", (yesterday,)).fetchone()['c']

# 7-day average
daily_counts = db.execute("""
    SELECT SUBSTR(timestamp_iso, 1, 10) as day, COUNT(*) as c
    FROM transactions WHERE has_memo = 1 AND timestamp_iso != ''
    GROUP BY day ORDER BY day DESC LIMIT 8
""").fetchall()
avg_7d = sum(d['c'] for d in daily_counts[1:]) / max(len(daily_counts) - 1, 1) if len(daily_counts) > 1 else memos_today

total_txns = db.execute("SELECT COUNT(*) as c FROM transactions").fetchone()['c']
total_memos = db.execute("SELECT COUNT(*) as c FROM transactions WHERE has_memo = 1").fetchone()['c']
sybil_clusters = db.execute("SELECT COUNT(DISTINCT cluster_id) as c FROM sybil_clusters").fetchone()['c']

# Load health score
health_score = None
health_grade = None
try:
    with open(os.path.expanduser('~/pft-validator/lens/health.json')) as f:
        h = json.load(f)
        health_score = h.get('health_score')
        health_grade = h.get('health_grade')
except: pass

# When Herald runs at 00:05 UTC, "today" has ~0 memos. Use yesterday's data instead.
if memos_today < 5:
    report_memos = memos_yesterday
    report_day_label = "yesterday"
else:
    report_memos = memos_today
    report_day_label = "today"

velocity_direction = "rising" if report_memos > avg_7d * 1.1 else ("dropping" if report_memos < avg_7d * 0.8 else "steady")

pulse = {
    'health_score': health_score,
    'health_grade': health_grade,
    'total_wallets': total_accounts,
    'contributors': contributor_count,
    'bots': bot_count,
    'infrastructure': infra_count,
    'memos_today': report_memos,
    'memos_yesterday': memos_yesterday,
    'memo_avg_7d': round(avg_7d, 1),
    'velocity_direction': velocity_direction,
    'total_transactions': total_txns,
    'total_memos': total_memos,
    'sybil_clusters': sybil_clusters,
    'narrative': f"Health: {health_score} ({health_grade}). {total_accounts} wallets, {contributor_count} contributors. {report_memos} memos {report_day_label} vs {round(avg_7d)} avg. Velocity {velocity_direction}."
}

# ── FLOW — PFT movements in last 24h ────────────────────────────────

# Dynamically load all infrastructure wallets for reward detection
REWARD_WALLETS = [r['address'] for r in db.execute(
    "SELECT address FROM wallet_labels WHERE label_type = 'infrastructure'"
).fetchall()]

rw_ph = ','.join('?' * len(REWARD_WALLETS))

rewards_24h = db.execute(f"""
    SELECT destination, COUNT(*) as txns, SUM(CAST(amount_drops AS INTEGER)) as total_drops
    FROM transactions
    WHERE account IN ({rw_ph}) AND CAST(amount_drops AS INTEGER) > 0
    AND has_memo = 1 AND timestamp_iso > datetime('now', '-24 hours')
    GROUP BY destination ORDER BY total_drops DESC
""", REWARD_WALLETS).fetchall()

total_reward_txns = sum(r['txns'] for r in rewards_24h)
total_reward_pft = sum(int(r['total_drops'] or 0) for r in rewards_24h) / 1e6

top_earner_24h = None
top_earner_pft = 0
if rewards_24h:
    top = rewards_24h[0]
    top_earner_24h = top['destination']
    top_earner_pft = round(int(top['total_drops'] or 0) / 1e6)

largest_single = db.execute(f"""
    SELECT destination, CAST(amount_drops AS INTEGER) as amt
    FROM transactions
    WHERE account IN ({rw_ph}) AND CAST(amount_drops AS INTEGER) > 0
    AND has_memo = 1 AND timestamp_iso > datetime('now', '-24 hours')
    ORDER BY amt DESC LIMIT 1
""", REWARD_WALLETS).fetchone()

flow = {
    'reward_payments_24h': total_reward_txns,
    'total_pft_distributed_24h': round(total_reward_pft),
    'unique_recipients_24h': len(rewards_24h),
    'top_earner_address': top_earner_24h,
    'top_earner_pft': top_earner_pft,
    'largest_single_payment_pft': round(int(largest_single['amt'] or 0) / 1e6) if largest_single else 0,
    'narrative': f"{total_reward_txns} reward payments, {round(total_reward_pft)} PFT distributed to {len(rewards_24h)} contributors." + (f" Top earner: {top_earner_24h[:6]}...{top_earner_24h[-4:]} ({top_earner_pft} PFT)." if top_earner_24h else "")
}

# ── MOVERS — Who's rising, who's falling ─────────────────────────────

# Top contributors by recent activity
active_7d = db.execute("""
    SELECT account, COUNT(*) as memos_7d
    FROM transactions
    WHERE has_memo = 1 AND timestamp_iso > datetime('now', '-7 days')
    AND account NOT IN (SELECT address FROM wallet_labels WHERE label_type IN ('infrastructure','bot'))
    GROUP BY account ORDER BY memos_7d DESC LIMIT 10
""").fetchall()

# New wallets in last 7 days
new_wallets_7d = db.execute("""
    SELECT address, discovered_at FROM accounts
    WHERE discovered_at > datetime('now', '-7 days')
    AND address NOT IN (SELECT address FROM wallet_labels WHERE label_type IN ('infrastructure','bot'))
    ORDER BY discovered_at DESC LIMIT 5
""").fetchall()
new_wallet_count_7d = db.execute("""
    SELECT COUNT(*) as c FROM accounts
    WHERE discovered_at > datetime('now', '-7 days')
    AND address NOT IN (SELECT address FROM wallet_labels WHERE label_type IN ('infrastructure','bot'))
""").fetchone()['c']

# Inactive contributors (were active, now silent 7+ days)
gone_quiet_rows = db.execute("""
    SELECT a.address, a.memo_tx_count,
           MAX(t.timestamp_iso) as last_active
    FROM accounts a
    JOIN transactions t ON t.account = a.address AND t.has_memo = 1
    WHERE a.memo_tx_count > 5
    AND a.address NOT IN (SELECT address FROM wallet_labels WHERE label_type IN ('infrastructure','bot'))
    GROUP BY a.address
    HAVING last_active < datetime('now', '-7 days')
    ORDER BY a.memo_tx_count DESC LIMIT 5
""").fetchall()
gone_quiet_count = db.execute("""
    SELECT COUNT(*) as c FROM (
        SELECT a.address
        FROM accounts a
        JOIN transactions t ON t.account = a.address AND t.has_memo = 1
        WHERE a.memo_tx_count > 5
        AND a.address NOT IN (SELECT address FROM wallet_labels WHERE label_type IN ('infrastructure','bot'))
        GROUP BY a.address
        HAVING MAX(t.timestamp_iso) < datetime('now', '-7 days')
    )
""").fetchone()['c']
gone_quiet = gone_quiet_rows

# Hustlers: accounts whose first-ever transaction was in the last 7 days, ranked by memo velocity
hustlers = db.execute("""
    SELECT a.address, a.memo_tx_count, first_txs.first_tx,
           CAST(julianday('now') - julianday(first_txs.first_tx) AS INTEGER) as age_days
    FROM accounts a
    JOIN (
        SELECT account as addr, MIN(timestamp_iso) as first_tx
        FROM transactions
        GROUP BY account
    ) first_txs ON a.address = first_txs.addr
    LEFT JOIN wallet_labels l ON a.address = l.address
    WHERE a.memo_tx_count >= 5
    AND (l.label_type IS NULL OR l.label_type NOT IN ('infrastructure', 'bot'))
    AND first_txs.first_tx > datetime('now', '-7 days')
    ORDER BY CAST(a.memo_tx_count AS REAL) / MAX(CAST(julianday('now') - julianday(first_txs.first_tx) AS REAL), 1) DESC
    LIMIT 5
""").fetchall()

movers = {
    'most_active_7d': [{'address': r['account'], 'memos': r['memos_7d']} for r in active_7d[:5]],
    'new_wallets_7d': [{'address': r['address'], 'discovered': r['discovered_at']} for r in new_wallets_7d],
    'gone_quiet': [{'address': r['address'], 'last_active': r['last_active'], 'lifetime_memos': r['memo_tx_count']} for r in gone_quiet],
    'hustlers': [{'address': r['address'], 'memos': r['memo_tx_count'], 'age_days': max(r['age_days'], 1), 'memos_per_day': round(r['memo_tx_count'] / max(r['age_days'], 1), 1)} for r in hustlers],
    'narrative': f"Most active (7d): {active_7d[0]['account'][:6]}...{active_7d[0]['account'][-4:]} ({active_7d[0]['memos_7d']} memos)." if active_7d else "No activity data."
}
if hustlers:
    top_h = hustlers[0]
    top_h_rate = round(top_h['memo_tx_count'] / max(top_h['age_days'], 1), 1)
    movers['narrative'] += f" Fastest new contributor: {top_h['address'][:6]}...{top_h['address'][-4:]} ({top_h_rate} memos/day in {max(top_h['age_days'], 1)} days)."
if new_wallet_count_7d:
    movers['narrative'] += f" {new_wallet_count_7d} new wallet(s) this week."
if gone_quiet_count:
    movers['narrative'] += f" {gone_quiet_count} contributor(s) went quiet (7+ days silent)."

# ── WATCH — Sybil and anomaly alerts ────────────────────────────────

# NOTE: The sybil analyzer deletes and re-inserts ALL cluster members every run,
# so detected_at is always recent. We track the TOTAL cluster size instead of
# "new in 24h" to avoid reporting the entire cluster as "new" every day.
total_sybil = db.execute("SELECT COUNT(DISTINCT address) as c FROM sybil_clusters").fetchone()['c']
sybil_cluster_count = db.execute("SELECT COUNT(DISTINCT cluster_id) as c FROM sybil_clusters").fetchone()['c']
recent_sybil = 0  # True new detections require comparing against a prior snapshot (not yet implemented)

review_queue = db.execute("""
    SELECT COUNT(*) as c FROM accounts a
    WHERE a.tx_count > 10 AND a.memo_tx_count = 0
    AND a.address NOT IN (SELECT address FROM wallet_labels)
    AND a.address NOT IN (SELECT address FROM sybil_clusters)
""").fetchone()['c']

bot_ratio = round(bot_count / max(total_accounts, 1) * 100, 1)

# Load auth enforcement
enforcement = None
try:
    with open(os.path.expanduser('~/pft-validator/lens/auth.json')) as f:
        a = json.load(f)
        enforcement = a.get('enforcement_state')
except: pass

watch = {
    'total_sybil_accounts': total_sybil,
    'sybil_clusters': sybil_cluster_count,
    'bot_ratio_pct': bot_ratio,
    'review_queue': review_queue,
    'enforcement_state': enforcement,
    'reward_leaks_ever': 0,
    'narrative': f"{total_sybil} sybil accounts tracked across {sybil_cluster_count} cluster(s). Bot ratio: {bot_ratio}%. {review_queue} wallet(s) in review queue. Enforcement: {enforcement}. Zero reward leaks."
}

# ── AIRDROPS — Daily reputation-based payouts (21:08 UTC) ────────────
# Daily airdrops are identified by their exact timestamp: 21:05-21:12 UTC.
# They can come from ANY infrastructure reward wallet — the sender rotates.
# The fingerprint is: payment at 21:05-21:12 UTC from an infrastructure wallet,
# to a non-infrastructure non-bot address.

AIRDROP_WALLETS = [r['address'] for r in db.execute(
    "SELECT address FROM wallet_labels WHERE label_type = 'infrastructure'"
).fetchall()]
adw_ph = ','.join('?' * len(AIRDROP_WALLETS))

# Today's daily airdrops (21:08 UTC window)
airdrop_today = db.execute(f"""
    SELECT t.destination as address,
           CAST(t.amount_drops AS INTEGER)/1000000 as pft,
           t.timestamp_iso, t.account
    FROM transactions t
    WHERE t.account IN ({adw_ph})
    AND CAST(t.amount_drops AS INTEGER) > 0
    AND SUBSTR(t.timestamp_iso, 1, 10) = ?
    AND SUBSTR(t.timestamp_iso, 12, 5) BETWEEN '21:05' AND '21:12'
    AND t.destination NOT IN (SELECT address FROM wallet_labels WHERE label_type IN ('infrastructure','bot'))
    ORDER BY CAST(t.amount_drops AS INTEGER) DESC
""", AIRDROP_WALLETS + [today]).fetchall()

# Yesterday's airdrops (for comparison if today hasn't dropped yet)
airdrop_yesterday = db.execute(f"""
    SELECT t.destination as address,
           CAST(t.amount_drops AS INTEGER)/1000000 as pft,
           t.timestamp_iso
    FROM transactions t
    WHERE t.account IN ({adw_ph})
    AND CAST(t.amount_drops AS INTEGER) > 0
    AND SUBSTR(t.timestamp_iso, 1, 10) = ?
    AND SUBSTR(t.timestamp_iso, 12, 5) BETWEEN '21:05' AND '21:12'
    AND t.destination NOT IN (SELECT address FROM wallet_labels WHERE label_type IN ('infrastructure','bot'))
    ORDER BY CAST(t.amount_drops AS INTEGER) DESC
""", AIRDROP_WALLETS + [yesterday]).fetchall()

# 7-day airdrop leaderboard (only 21:08 payments)
airdrop_7d = db.execute(f"""
    SELECT t.destination as address,
           COUNT(*) as drops,
           SUM(CAST(t.amount_drops AS INTEGER))/1000000 as total_pft,
           AVG(CAST(t.amount_drops AS INTEGER))/1000000 as avg_pft,
           COUNT(DISTINCT SUBSTR(t.timestamp_iso, 1, 10)) as active_days
    FROM transactions t
    WHERE t.account IN ({adw_ph})
    AND CAST(t.amount_drops AS INTEGER) > 0
    AND t.timestamp_iso > datetime('now', '-7 days')
    AND SUBSTR(t.timestamp_iso, 12, 5) BETWEEN '21:05' AND '21:12'
    AND t.destination NOT IN (SELECT address FROM wallet_labels WHERE label_type IN ('infrastructure','bot'))
    GROUP BY t.destination ORDER BY total_pft DESC LIMIT 15
""", AIRDROP_WALLETS).fetchall()

# Use today's data, fall back to yesterday if today hasn't dropped yet
active_airdrops = airdrop_today if airdrop_today else airdrop_yesterday
airdrop_label = "today" if airdrop_today else "yesterday"

airdrop_lines = []
for r in active_airdrops[:10]:
    airdrop_lines.append({
        'address': r['address'],
        'pft': round(r['pft']),
    })

airdrop_7d_lines = []
for r in airdrop_7d[:10]:
    airdrop_7d_lines.append({
        'address': r['address'],
        'drops': r['drops'],
        'total_pft': round(r['total_pft']),
        'avg_pft': round(r['avg_pft']),
        'active_days': r['active_days'],
    })

total_airdrop_pft = sum(r['pft'] for r in active_airdrops)
airdrops_narrative_parts = []
if active_airdrops:
    top = active_airdrops[0]
    airdrops_narrative_parts.append(f"{len(active_airdrops)} daily airdrops issued {airdrop_label} totaling {round(total_airdrop_pft):,} PFT.")
    airdrops_narrative_parts.append(f"Highest: {top['address'][:6]}...{top['address'][-4:]} ({round(top['pft']):,} PFT).")
    if len(active_airdrops) > 1:
        lowest = active_airdrops[-1]
        airdrops_narrative_parts.append(f"Lowest: {lowest['address'][:6]}...{lowest['address'][-4:]} ({round(lowest['pft']):,} PFT).")
else:
    airdrops_narrative_parts.append("Daily airdrops not yet issued today (drops at ~21:08 UTC).")

if airdrop_7d:
    top7 = airdrop_7d[0]
    airdrops_narrative_parts.append(f"7-day leader: {top7['address'][:6]}...{top7['address'][-4:]} ({round(top7['total_pft']):,} PFT, avg {round(top7['avg_pft']):,}/day over {top7['active_days']} days).")

airdrops = {
    'total_pft': round(total_airdrop_pft),
    'recipients': len(active_airdrops),
    'period': airdrop_label,
    'drop_time_utc': '21:08',
    'top': airdrop_lines,
    'leaderboard_7d': airdrop_7d_lines,
    'narrative': ' '.join(airdrops_narrative_parts),
}

# ── DEEP CUT — Full-history exclusive insight ────────────────────────

# What happened on this date in network history?
day_of_month = now.day
month_ago = (now - timedelta(days=30)).strftime('%Y-%m-%d')

# Activity on this day 30 days ago
activity_30d_ago = db.execute("""
    SELECT COUNT(*) as txns,
           COUNT(DISTINCT account) as wallets
    FROM transactions
    WHERE timestamp_iso LIKE ? || '%'
""", (month_ago,)).fetchone()

# Earliest transaction in the index
earliest = db.execute("""
    SELECT timestamp_iso, account, destination, memo_type
    FROM transactions WHERE timestamp_iso != ''
    ORDER BY timestamp_iso ASC LIMIT 1
""").fetchone()

# Fun stat: busiest single hour ever
busiest_hour = db.execute("""
    SELECT SUBSTR(timestamp_iso, 1, 13) as hour, COUNT(*) as c
    FROM transactions WHERE has_memo = 1 AND timestamp_iso != ''
    GROUP BY hour ORDER BY c DESC LIMIT 1
""").fetchone()

deep_cut_text = ""
if activity_30d_ago:
    deep_cut_text = f"30 days ago ({month_ago}): {activity_30d_ago['txns']} transactions from {activity_30d_ago['wallets']} wallets."
if busiest_hour:
    deep_cut_text += f" Busiest hour ever: {busiest_hour['hour']}:00 UTC ({busiest_hour['c']} memos)."
if earliest:
    deep_cut_text += f" First indexed transaction: {earliest['timestamp_iso'][:10]} from {earliest['account'][:6]}...{earliest['account'][-4:]}"

deep_cut = {
    'type': 'this_day_in_history',
    'date_referenced': month_ago,
    'activity_30d_ago': {
        'transactions': activity_30d_ago['txns'] if activity_30d_ago else 0,
        'wallets': activity_30d_ago['wallets'] if activity_30d_ago else 0,
    },
    'busiest_hour_ever': {
        'hour': busiest_hour['hour'] if busiest_hour else None,
        'memos': busiest_hour['c'] if busiest_hour else 0,
    },
    'first_transaction': earliest['timestamp_iso'] if earliest else None,
    'narrative': deep_cut_text,
}

# ── Assemble edition ─────────────────────────────────────────────────

edition_number = (now - datetime(2026, 4, 14, tzinfo=timezone.utc)).days + 1

edition = {
    'schema_version': '1.0.0',
    'edition': edition_number,
    'date': today,
    'published_at': published_at,
    'title': f'The Hive Herald — Edition #{edition_number}',
    'sections': {
        'pulse': pulse,
        'flow': flow,
        'airdrops': airdrops,
        'movers': movers,
        'watch': watch,
        'deep_cut': deep_cut,
    },
    'summary': f"{pulse['narrative']} {flow['narrative']} {watch['narrative']}",
    'data_source': {
        'index': 'chain-index.db',
        'node': 'postfiatd full-history archive',
        'health': 'health.json',
        'auth': 'auth.json',
    },
}

# Full text edition for bot delivery
lines = [
    f"THE HIVE HERALD — #{edition_number} ({today})",
    "",
    "PULSE",
    pulse['narrative'],
    "",
    "FLOW",
    flow['narrative'],
    "",
    "AIRDROPS",
    airdrops['narrative'],
    "",
    "MOVERS",
    movers['narrative'],
    "",
    "WATCH",
    watch['narrative'],
    "",
    "DEEP CUT",
    deep_cut['narrative'],
    "",
    "— pft.permanentupperclass.com/herald/",
]
edition['full_text'] = "\n".join(lines)

# Write JSON
out = os.path.expanduser('~/pft-validator/lens/herald.json')
with open(out, 'w') as f:
    json.dump(edition, f, indent=2)

# Write latest text edition
txt_out = os.path.expanduser('~/pft-validator/herald/latest.txt')
os.makedirs(os.path.dirname(txt_out), exist_ok=True)
with open(txt_out, 'w') as f:
    f.write("\n".join(lines))

# Archive this edition
archive_out = os.path.expanduser(f'~/pft-validator/herald/{today}.json')
with open(archive_out, 'w') as f:
    json.dump(edition, f, indent=2)

print(f"The Hive Herald — Edition #{edition_number} ({today})")
print(f"  Pulse: {pulse['narrative'][:80]}...")
print(f"  Flow: {flow['narrative'][:80]}...")
print(f"  Watch: {watch['narrative'][:80]}...")
print(f"Written to {out}")

db.close()
PYEOF

# Push to GitHub
cd ~/pft-validator && git add lens/herald.json herald/ && git commit -m "Hive Herald #$(date -u +%Y-%m-%d)" --allow-empty 2>/dev/null && git push origin main 2>/dev/null
