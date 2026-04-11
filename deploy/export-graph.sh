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

edges = db.execute("""
    SELECT from_address, to_address, tx_count, memo_tx_count, total_amount_drops, first_seen, last_seen
    FROM edges WHERE tx_count > 0 ORDER BY tx_count DESC
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
        'type': 'infrastructure' if a['label_type'] == 'infrastructure' else 'contributor',
        'memo_count': a['memo_tx_count'], 'tx_count': a['tx_count'],
        'balance_pft': round(bal, 2), 'peers': p, 'activity_score': act,
        'sybil_flagged': s is not None,
        'sybil_cluster': s['cluster_id'] if s else None,
        'sybil_confidence': s['confidence'] if s else None,
    })

node_ids = set(n['id'] for n in nodes)
edge_list = []
for e in edges:
    # Only include edges where both endpoints are in the node set
    if e['from_address'] not in node_ids or e['to_address'] not in node_ids:
        continue
    amt = int(e['total_amount_drops'] or 0) / 1e6
    ht = e['memo_tx_count'] >= 3
    hv = amt > 0
    tf = 'TRUST_PLUS_VALUE' if ht and hv else ('TRUST_WITHOUT_VALUE' if ht else ('FLOW_WITHOUT_TRUST' if hv else 'WEAK'))
    edge_list.append({
        'source': e['from_address'], 'target': e['to_address'],
        'memo_count': e['memo_tx_count'], 'tx_count': e['tx_count'],
        'amount_pft': round(amt, 2), 'trust_flow': tf,
        'first_seen': e['first_seen'], 'last_seen': e['last_seen'],
    })

stats = {
    'total_accounts': len(nodes), 'total_edges': len(edge_list),
    'total_transactions': db.execute('SELECT COUNT(*) as c FROM transactions').fetchone()['c'],
    'memo_transactions': db.execute('SELECT COUNT(*) as c FROM transactions WHERE has_memo = 1').fetchone()['c'],
    'sybil_clusters': len(set(s['cluster_id'] for s in sybil.values())),
    'generated_at': db.execute("SELECT value FROM crawl_state WHERE key = 'last_crawl_at'").fetchone()['value'],
}

out = os.path.expanduser('~/pft-validator/lens/graph.json')
with open(out, 'w') as f:
    json.dump({'stats': stats, 'nodes': nodes, 'edges': edge_list}, f, indent=2)

print(f"Exported {len(nodes)} nodes, {len(edge_list)} edges")
db.close()
PYEOF

# Push to GitHub
cd ~/pft-validator && git add lens/graph.json && git commit -m "Daily graph.json update $(date -u +%Y-%m-%d)" --allow-empty 2>/dev/null && git push origin main 2>/dev/null
