#!/bin/bash
# Export chain-index.db → graph.json for Lens frontend
# Runs after the daily indexer crawl

python3 << 'PYEOF'
import sqlite3, json, os

db = sqlite3.connect(os.path.expanduser('~/.pf-scout/chain-index.db'))
db.row_factory = sqlite3.Row

accounts = db.execute("""
    SELECT a.address, a.tx_count, a.memo_tx_count, a.balance_drops,
           l.label, l.label_type
    FROM accounts a LEFT JOIN wallet_labels l ON a.address = l.address
    WHERE a.tx_count > 0 ORDER BY a.memo_tx_count DESC, a.tx_count DESC
""").fetchall()

# Limit rendered edges: only significant edges to avoid freezing the graph layout.
# Keep:
#   - All memo-carrying edges (communication, always meaningful)
#   - Edges with tx_count >= 3 (repeated interactions, not one-off dust)
# Cap at 5000 total to prevent overload.
edges = db.execute("""
    SELECT from_address, to_address, tx_count, memo_tx_count, total_amount_drops, first_seen, last_seen
    FROM edges
    WHERE tx_count > 0
      AND (memo_tx_count > 0 OR tx_count >= 3)
    ORDER BY memo_tx_count DESC, tx_count DESC
    LIMIT 5000
""").fetchall()

sybil = {r['address']: {'cluster_id': r['cluster_id'], 'confidence': r['confidence']}
         for r in db.execute("SELECT address, cluster_id, confidence FROM sybil_clusters").fetchall()}

peers = {r['address']: r['peers'] for r in db.execute("""
    SELECT address, COUNT(DISTINCT cp) as peers FROM (
        SELECT from_address as address, to_address as cp FROM edges WHERE tx_count > 0
        UNION ALL SELECT to_address, from_address FROM edges WHERE tx_count > 0
    ) GROUP BY address
""").fetchall()}

max_memo = max((a['memo_tx_count'] for a in accounts), default=1)

nodes = []
for a in accounts:
    addr = a['address']
    bal = int(a['balance_drops'] or 0) / 1e6
    p = peers.get(addr, 0)
    act = round(min(a['memo_tx_count']/max(max_memo,1), 1)*0.7 + min(p/30, 1)*0.3, 4)
    s = sybil.get(addr)
    nodes.append({
        'id': addr, 'label': a['label'] or (addr[:8]+'...'+addr[-4:]),
        'type': 'infrastructure' if a['label_type'] == 'infrastructure' else ('bot' if a['label_type'] == 'bot' else 'contributor'),
        'memo_count': a['memo_tx_count'], 'tx_count': a['tx_count'],
        'balance_pft': round(bal, 2), 'peers': p, 'activity_score': act,
        'sybil_flagged': s is not None,
        'sybil_cluster': s['cluster_id'] if s else None,
        'sybil_confidence': s['confidence'] if s else None,
    })

node_ids = set(n['id'] for n in nodes)

# Build reverse lookup to detect bidirectional edges
edge_exists = set()
for e in edges:
    edge_exists.add((e['from_address'], e['to_address']))

edge_list = []
seen_pairs = set()
for e in edges:
    if e['from_address'] not in node_ids or e['to_address'] not in node_ids:
        continue
    # Deduplicate: canonical pair key
    pair = tuple(sorted([e['from_address'], e['to_address']]))
    if pair in seen_pairs:
        continue
    seen_pairs.add(pair)

    amt = int(e['total_amount_drops'] or 0) / 1e6
    # Check for reverse edge
    is_bidir = (e['to_address'], e['from_address']) in edge_exists
    ht = e['memo_tx_count'] >= 3
    hv = amt > 0
    tf = 'TRUST_PLUS_VALUE' if ht and hv else ('TRUST_WITHOUT_VALUE' if ht else ('FLOW_WITHOUT_TRUST' if hv else 'WEAK'))
    edge_list.append({
        'source': e['from_address'], 'target': e['to_address'],
        'memo_count': e['memo_tx_count'], 'tx_count': e['tx_count'],
        'amount_pft': round(amt, 2), 'trust_flow': tf,
        'bidirectional': is_bidir,
        'first_seen': e['first_seen'], 'last_seen': e['last_seen'],
    })

from collections import Counter
total_memo_sum = sum(a['memo_tx_count'] for a in accounts) or 1
hhi = sum((a['memo_tx_count'] / total_memo_sum) ** 2 for a in accounts)
bidir = sum(1 for e in edge_list if e.get('bidirectional', False))
value_edges = sum(1 for e in edge_list if e.get('amount_pft', 0) > 0)

# Sparkline
tx_times = db.execute("SELECT timestamp_iso FROM transactions WHERE has_memo = 1 AND timestamp_iso IS NOT NULL AND timestamp_iso != '' ORDER BY timestamp_iso").fetchall()
daily = Counter()
for t in tx_times:
    daily[t['timestamp_iso'][:10]] += 1
sparkline_days = sorted(daily.keys())[-30:]
sparkline = [daily.get(d, 0) for d in sparkline_days]

# Airdrop stats (daily airdrops at 21:05-21:12 from reward wallets)
# All infrastructure wallets can send daily airdrops (sender rotates)
AIRDROP_WALLETS_LIST = [r['address'] for r in db.execute(
    "SELECT address FROM wallet_labels WHERE label_type = 'infrastructure'"
).fetchall()]
adw_ph2 = ','.join('?' * len(AIRDROP_WALLETS_LIST))

# Cumulative airdrops (all time)
airdrop_cumulative = db.execute(f"""
    SELECT COUNT(DISTINCT destination) as unique_recipients,
           COUNT(*) as total_drops,
           COALESCE(SUM(CAST(amount_drops AS INTEGER)), 0)/1000000 as total_pft
    FROM transactions
    WHERE account IN ({adw_ph2})
    AND CAST(amount_drops AS INTEGER) > 0
    AND SUBSTR(timestamp_iso, 12, 5) BETWEEN '21:05' AND '21:12'
    AND destination NOT IN (SELECT address FROM wallet_labels WHERE label_type IN ('infrastructure','bot'))
""", AIRDROP_WALLETS_LIST).fetchone()

# Today's airdrops
import datetime as _dt
_today = _dt.datetime.now(_dt.timezone.utc).strftime('%Y-%m-%d')
airdrop_today = db.execute(f"""
    SELECT COUNT(DISTINCT destination) as recipients,
           COUNT(*) as drops,
           COALESCE(SUM(CAST(amount_drops AS INTEGER)), 0)/1000000 as total_pft
    FROM transactions
    WHERE account IN ({adw_ph2})
    AND CAST(amount_drops AS INTEGER) > 0
    AND SUBSTR(timestamp_iso, 1, 10) = ?
    AND SUBSTR(timestamp_iso, 12, 5) BETWEEN '21:05' AND '21:12'
    AND destination NOT IN (SELECT address FROM wallet_labels WHERE label_type IN ('infrastructure','bot'))
""", AIRDROP_WALLETS_LIST + [_today]).fetchone()

# Yesterday's airdrops (fallback when today's haven't happened yet)
_yesterday = (_dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(days=1)).strftime('%Y-%m-%d')
airdrop_yesterday = db.execute(f"""
    SELECT COUNT(DISTINCT destination) as recipients,
           COUNT(*) as drops,
           COALESCE(SUM(CAST(amount_drops AS INTEGER)), 0)/1000000 as total_pft
    FROM transactions
    WHERE account IN ({adw_ph2})
    AND CAST(amount_drops AS INTEGER) > 0
    AND SUBSTR(timestamp_iso, 1, 10) = ?
    AND SUBSTR(timestamp_iso, 12, 5) BETWEEN '21:05' AND '21:12'
    AND destination NOT IN (SELECT address FROM wallet_labels WHERE label_type IN ('infrastructure','bot'))
""", AIRDROP_WALLETS_LIST + [_yesterday]).fetchone()

# Hustlers: accounts whose first-ever transaction was in the last 7 days, ranked by memo velocity
hustlers_data = db.execute("""
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
    LIMIT 10
""").fetchall()
hustlers_list = [{'address': r['address'], 'memos': r['memo_tx_count'], 'age_days': max(r['age_days'], 1), 'memos_per_day': round(r['memo_tx_count'] / max(r['age_days'], 1), 1), 'first_tx': r['first_tx'][:10]} for r in hustlers_data]

stats = {
    'total_accounts': len(nodes), 'total_edges': len(edge_list),
    'total_transactions': db.execute('SELECT COUNT(*) as c FROM transactions').fetchone()['c'],
    'memo_transactions': db.execute('SELECT COUNT(*) as c FROM transactions WHERE has_memo = 1').fetchone()['c'],
    'sybil_clusters': len(set(s['cluster_id'] for s in sybil.values())),
    'concentration_hhi': round(hhi, 4),
    'bidirectional_edges': bidir,
    'value_transfer_edges': value_edges,
    'sparkline': sparkline,
    'sparkline_days': sparkline_days,
    'new_wallets_this_week': 0,
    'generated_at': db.execute("SELECT value FROM crawl_state WHERE key = 'last_crawl_at'").fetchone()['value'],
    'airdrops': {
        'cumulative_recipients': airdrop_cumulative['unique_recipients'],
        'cumulative_drops': airdrop_cumulative['total_drops'],
        'cumulative_pft': airdrop_cumulative['total_pft'],
        'today_recipients': airdrop_today['recipients'],
        'today_drops': airdrop_today['drops'],
        'today_pft': airdrop_today['total_pft'],
        'yesterday_recipients': airdrop_yesterday['recipients'],
        'yesterday_drops': airdrop_yesterday['drops'],
        'yesterday_pft': airdrop_yesterday['total_pft'],
    },
    'hustlers': hustlers_list,
}

out = os.path.expanduser('~/pft-validator/lens/graph.json')
with open(out, 'w') as f:
    json.dump({'stats': stats, 'nodes': nodes, 'edges': edge_list}, f, indent=2)

# Delta tracking
prev_raw = db.execute("SELECT value FROM crawl_state WHERE key = 'last_snapshot'").fetchone()
prev = json.loads(prev_raw['value']) if prev_raw else {}

current_snap = {
    'accounts': len(nodes),
    'transactions': stats['total_transactions'],
    'edges': stats['total_edges'],
    'memos': stats['memo_transactions'],
}

deltas = {}
for k in current_snap:
    old = prev.get(k, current_snap[k])
    deltas[k] = current_snap[k] - old

stats['deltas'] = deltas
stats['delta_since'] = prev.get('_timestamp', stats['generated_at'])

# Save new snapshot
current_snap['_timestamp'] = stats['generated_at']
db.execute("INSERT OR REPLACE INTO crawl_state (key, value) VALUES ('last_snapshot', ?)", (json.dumps(current_snap),))
db.commit()

# Write final JSON with deltas included
out = os.path.expanduser('~/pft-validator/lens/graph.json')
with open(out, 'w') as f:
    json.dump({'stats': stats, 'nodes': nodes, 'edges': edge_list}, f, indent=2)

if any(v != 0 for v in deltas.values()):
    print(f"Deltas: accounts={deltas.get('accounts',0):+d} txns={deltas.get('transactions',0):+d} edges={deltas.get('edges',0):+d} memos={deltas.get('memos',0):+d}")
else:
    print("No changes since last update")

print(f"Exported {len(nodes)} nodes, {len(edge_list)} edges")
db.close()
PYEOF

# Push to GitHub. NOTE: trailing `|| true` is load-bearing — hourly-pipeline.sh runs
# `set -e`, and this script is followed by export-health/auth/subs/herald. Without the
# guard, a push failure (e.g. wiped github.com credential → 403) makes this script exit
# non-zero, which aborts the pipeline and silently freezes the downstream feeds. Decoupled
# 2026-07-06 after that exact cascade froze health/auth/subs/herald for ~10 days.
cd ~/pft-validator && git add lens/graph.json lens/audit.json && git commit -m "Lens update $(date -u +%Y-%m-%dT%H:%M)" --allow-empty 2>/dev/null && { git push origin main 2>/dev/null || echo "WARN: lens push failed (credential?) — commits will accumulate until push is restored"; } || true
