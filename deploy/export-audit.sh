#!/bin/bash
python3 << 'PYEOF'
import json, sqlite3, urllib.request, os, time

db = sqlite3.connect(os.path.expanduser('~/.pf-scout/chain-index.db'))
db.row_factory = sqlite3.Row
db.execute('PRAGMA busy_timeout = 5000')

try:
    data = json.dumps({'method': 'server_info', 'params': [{}]}).encode()
    req = urllib.request.Request('http://127.0.0.1:5015', data, {'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=5) as resp:
        ni = json.loads(resp.read())['result']['info']
        node_ledgers = ni.get('complete_ledgers', 'unknown')
        node_peers = ni.get('peers', 0)
except:
    node_ledgers = 'unavailable'; node_peers = 0

accounts = db.execute("SELECT COUNT(*) FROM accounts WHERE tx_count > 0").fetchone()[0]
transactions = db.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
edges = db.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
memos = db.execute("SELECT COUNT(*) FROM transactions WHERE has_memo = 1").fetchone()[0]
bots = db.execute("SELECT COUNT(*) FROM wallet_labels WHERE label_type = 'bot'").fetchone()[0]
infra = db.execute("SELECT COUNT(*) FROM wallet_labels WHERE label_type = 'infrastructure'").fetchone()[0]
sybil_c = db.execute("SELECT COUNT(DISTINCT cluster_id) FROM sybil_clusters").fetchone()[0]
sybil_a = db.execute("SELECT COUNT(DISTINCT address) FROM sybil_clusters").fetchone()[0]
min_l = db.execute("SELECT MIN(ledger_index) FROM transactions WHERE ledger_index > 0").fetchone()[0]
max_l = db.execute("SELECT MAX(ledger_index) FROM transactions").fetchone()[0]
min_t = db.execute("SELECT MIN(timestamp_iso) FROM transactions WHERE timestamp_iso != ''").fetchone()[0]
max_t = db.execute("SELECT MAX(timestamp_iso) FROM transactions WHERE timestamp_iso != ''").fetchone()[0]
lc = db.execute("SELECT value FROM crawl_state WHERE key = 'last_crawl_at'").fetchone()
pr = db.execute("SELECT value FROM crawl_state WHERE key = 'last_snapshot'").fetchone()
prev = json.loads(pr['value']) if pr else {}

current = {'accounts': accounts, 'transactions': transactions, 'edges': edges, 'memos': memos}
deltas = {k: current[k] - prev.get(k, current[k]) for k in current}

sa = 'rsS2Y6CK9dz9dVFjJvRyD2gBdoLPqjaXRZ'
s = db.execute("SELECT * FROM accounts WHERE address = ?", (sa,)).fetchone()
st = db.execute("SELECT * FROM account_timestamps WHERE address = ?", (sa,)).fetchone()
se = db.execute("""SELECT e.from_address, e.to_address, e.tx_count, e.memo_tx_count, e.total_amount_drops, l.label as pl, l.label_type as pt
    FROM edges e LEFT JOIN wallet_labels l ON (CASE WHEN e.from_address = ? THEN e.to_address ELSE e.from_address END) = l.address
    WHERE (e.from_address = ? OR e.to_address = ?) AND e.tx_count > 0 ORDER BY e.memo_tx_count DESC LIMIT 8""", (sa, sa, sa)).fetchall()

merged = {}
for e in se:
    peer = e['to_address'] if e['from_address'] == sa else e['from_address']
    d = 'out' if e['from_address'] == sa else 'in'
    if peer not in merged:
        merged[peer] = {'peer': peer[:20]+'...', 'label': e['pl'], 'type': e['pt'] or 'contributor', 'in_tx': 0, 'out_tx': 0, 'in_memo': 0, 'out_memo': 0, 'pft': 0}
    m = merged[peer]; pft = int(e['total_amount_drops'] or 0) / 1e6
    if d == 'in': m['in_tx'] += e['tx_count']; m['in_memo'] += e['memo_tx_count']
    else: m['out_tx'] += e['tx_count']; m['out_memo'] += e['memo_tx_count']
    m['pft'] += pft
rels = sorted(merged.values(), key=lambda x: -(x['in_memo']+x['out_memo']))

bal = int(s['balance_drops'] or 0)/1e6 if s else 0
mc = s['memo_tx_count'] if s else 0; tc = s['tx_count'] if s else 0
has_deep = min_l and min_l < 1750000
conf = 'high' if mc > 10 and has_deep else ('medium' if mc > 0 else 'low')
gen = lc['value'] if lc else time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

audit = {
    'schema_version': '2.0.0', 'methodology_version': '2.1.0',
    'classification_ruleset_version': '1.2.0', 'sybil_ruleset_version': '1.1.0',
    'generated_at': gen, 'refresh_cadence': 'hourly',
    'coverage': {'node_ledger_range': node_ledgers, 'node_peers': node_peers, 'indexed_ledger_range': f'{min_l}-{max_l}' if min_l else 'empty', 'indexed_time_range': {'from': min_t, 'to': max_t}, 'public_node_range': '1750054-latest (~90K ledgers)', 'our_depth_advantage': f'{1750054-(min_l or 1750054):,} additional ledgers' if min_l and min_l < 1750054 else 'syncing', 'completeness_note': 'Deepest node on Post Fiat testnet. Backfill ongoing.'},
    'totals': {'accounts': accounts, 'transactions': transactions, 'edges': edges, 'memos': memos, 'bots_detected': bots, 'infrastructure_wallets': infra, 'sybil_clusters': sybil_c, 'sybil_flagged_addresses': sybil_a, 'humans': accounts-bots-infra},
    'deltas_since_last_update': {'summary': deltas, 'completeness_window_changed': node_ledgers != prev.get('_node_ledgers', node_ledgers), 'methodology_version_changed': False},
    'methodology': {'indexing': 'Outward crawl from 5 seed accounts via account_tx RPC.', 'classification': {'human': '>= 1 memo tx.', 'bot': 'Zero memos + bot signals.', 'infrastructure': 'Manually tagged.'}, 'sybil_detection': {'heuristics': [{'id': 'H1', 'name': 'zero_memo_high_tx', 'threshold': '50+ txns, 0 memos', 'weight': 0.4}, {'id': 'H2', 'name': 'uniform_balance', 'threshold': '~15 PFT + 50+ txns', 'weight': 0.2}, {'id': 'H3', 'name': 'peer_cluster_density', 'threshold': '>30% bot peers', 'weight': 0.3}, {'id': 'H4', 'name': 'counterparty_overlap', 'threshold': 'Jaccard >= 0.6 excl. infra', 'weight': 0.3}], 'min_confidence': 0.5}, 'data_source': 'Private full-history node (testnet-full, ledger_history=full, network_id=2025).'},
    'audit_guarantees': ['Public-safe data only.', 'Hourly refresh.', 'Classifications are heuristic, not identity claims.', 'Observable transactions only.', 'Infrastructure labels manually curated.'],
    'blind_spots': ['Zero-memo is not proof of automation.', 'Graph edges do not imply ownership.', 'Early-history gaps shrink as backfill continues.', 'Encrypted memo content not decryptable.'],
    'sample_profile': {'address': sa, 'tx_count': tc, 'memo_count': mc, 'balance_pft': round(bal, 2), 'first_activity': st['first_seen_iso'] if st else None, 'last_activity': st['last_seen_iso'] if st else None, 'history_confidence': conf, 'relationships': rels, 'consistency_check': {'tx_gte_memo': tc >= mc, 'first_lte_last': (st['first_seen_iso'] or '') <= (st['last_seen_iso'] or '') if st else True}},
}

with open(os.path.expanduser('~/pft-validator/lens/audit.json'), 'w') as f:
    json.dump(audit, f, indent=2)
print(f"Audit: {accounts} accts, {transactions} txns, coverage {node_ledgers}")
db.close()
PYEOF
