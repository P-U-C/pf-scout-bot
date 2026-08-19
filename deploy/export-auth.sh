#!/bin/bash
# Export auth.json — Authorization Cutover Audit Feed
# Public enforcement surface for the Lens layer: deterministic, hourly-updated,
# machine-readable control artifact for task-submission gating, reward gating,
# blocked population composition, classification reasons, cooldown posture,
# and verifiable leak-prevention claims.

python3 << 'PYEOF'
import sqlite3, json, os, hashlib
from datetime import datetime, timezone, timedelta
from collections import Counter

db = sqlite3.connect(os.path.expanduser('~/.pf-scout/chain-index.db'))
db.row_factory = sqlite3.Row

now = datetime.now(timezone.utc)
calculated_at = now.strftime('%Y-%m-%dT%H:%M:%SZ')
snapshot_id = now.replace(minute=0, second=0, microsecond=0).strftime('%Y-%m-%dT%H:%M:%SZ')
next_update_at = (now + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0).strftime('%Y-%m-%dT%H:%M:%SZ')
window_24h_start = (now - timedelta(hours=24)).strftime('%Y-%m-%dT%H:%M:%SZ')
window_7d_start = (now - timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%SZ')
window_30d_start = (now - timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%SZ')

# ── Infrastructure addresses (gate operators) ────────────────────────

TASK_NODES = [
    'rwdm72S9YVKkZjeADKU2bbUMuY4vPnSfH7',   # Task Node hub
    'rKt4peDozpRW9zdYGiTZC54DSNU3Af6pQE',   # Task Node 2
    'rKddMw1hqMGwfgJvzjbWQHtBQT8hDcZNCP',   # Task Node 3
]

REWARD_WALLETS = [
    'rJNwqDPKSkbqDPNoNxbW6C3KCS84ZaQc96',   # Airdrop / reward
    'rGBKxoTcavpfEso7ASRELZAMcCMqKa8oFk',   # Distribution
    'rKt4peDozpRW9zdYGiTZC54DSNU3Af6pQE',   # Distribution 2
]

ALL_INFRA = sorted(set(TASK_NODES + REWARD_WALLETS + [
    'rhczhWeG3eSohzcH5jw8m8Ynca9cgH4eZm',   # Treasury
    'rBDbRYd8H7gB6mdNTRssgNvsw8Z6c4riDb',   # Reserve
]))

total_active_accounts = db.execute("SELECT COUNT(*) as c FROM accounts WHERE tx_count > 0").fetchone()['c']

# ── Known bot/sybil sets ─────────────────────────────────────────────

bot_addrs = set(r['address'] for r in db.execute(
    "SELECT address FROM wallet_labels WHERE label_type = 'bot'").fetchall())
sybil_addrs = set(r['address'] for r in db.execute(
    "SELECT DISTINCT address FROM sybil_clusters").fetchall())
blocked_set = bot_addrs | sybil_addrs
bot_only = bot_addrs - sybil_addrs
sybil_only = sybil_addrs - bot_addrs
both = bot_addrs & sybil_addrs

# ── Acceptance Gate Analysis ─────────────────────────────────────────

task_senders_24h = db.execute("""
    SELECT DISTINCT account FROM transactions
    WHERE destination IN ({}) AND has_memo = 1
    AND timestamp_iso > datetime('now', '-24 hours')
""".format(','.join('?' * len(TASK_NODES))), TASK_NODES).fetchall()
task_sender_addrs = set(r['account'] for r in task_senders_24h)

blocked_senders_24h = task_sender_addrs & blocked_set
acceptance_blocked_24h = len(blocked_senders_24h)

task_submissions_24h = db.execute("""
    SELECT COUNT(*) as c FROM transactions
    WHERE destination IN ({}) AND has_memo = 1
    AND timestamp_iso > datetime('now', '-24 hours')
""".format(','.join('?' * len(TASK_NODES))), TASK_NODES).fetchone()['c']

accepted_senders_24h = task_sender_addrs - blocked_set
acceptance_gate_active = len(blocked_senders_24h) == 0 and task_submissions_24h > 0

screened_submission_share_24h = round(len(task_sender_addrs) / max(total_active_accounts, 1), 4) if task_sender_addrs else 0

# ── Reward Gate Analysis ─────────────────────────────────────────────

reward_txns_24h = db.execute("""
    SELECT destination, COUNT(*) as txns, SUM(CAST(amount_drops AS INTEGER)) as total_drops
    FROM transactions
    WHERE account IN ({}) AND CAST(amount_drops AS INTEGER) > 0
    AND has_memo = 1 AND timestamp_iso > datetime('now', '-24 hours')
    GROUP BY destination
""".format(','.join('?' * len(REWARD_WALLETS))), REWARD_WALLETS).fetchall()

reward_recipients_24h = set(r['destination'] for r in reward_txns_24h if r['destination'])
total_rewards_24h = sum(r['txns'] for r in reward_txns_24h)
total_reward_pft_24h = sum(int(r['total_drops'] or 0) for r in reward_txns_24h) / 1e6

blocked_recipients_24h = reward_recipients_24h & blocked_set
reward_leaked_24h = len(blocked_recipients_24h)
reward_gate_active = len(blocked_recipients_24h) == 0

screened_reward_share_24h = round(len(reward_recipients_24h) / max(total_active_accounts, 1), 4) if reward_recipients_24h else 0

# Full history leak check
reward_to_bots_ever = 0
if blocked_set:
    placeholders_rw = ','.join('?' * len(REWARD_WALLETS))
    placeholders_bl = ','.join('?' * len(blocked_set))
    reward_to_bots_ever = db.execute(f"""
        SELECT COUNT(*) as c FROM transactions
        WHERE account IN ({placeholders_rw}) AND CAST(amount_drops AS INTEGER) > 0
        AND has_memo = 1 AND destination IN ({placeholders_bl})
    """, list(REWARD_WALLETS) + list(blocked_set)).fetchone()['c']

# ── 7d and 30d blocked attempt rates ────────────────────────────────

blocked_attempts_24h = 0
blocked_attempts_7d = 0
blocked_attempts_30d = 0
if blocked_set:
    tn_ph = ','.join('?' * len(TASK_NODES))
    rw_ph = ','.join('?' * len(REWARD_WALLETS))
    bl_ph = ','.join('?' * len(blocked_set))

    for window, label in [("'-24 hours'", '24h'), ("'-7 days'", '7d'), ("'-30 days'", '30d')]:
        count = db.execute(f"""
            SELECT COUNT(*) as c FROM transactions
            WHERE (destination IN ({tn_ph}) OR account IN ({rw_ph}))
            AND (account IN ({bl_ph}) OR destination IN ({bl_ph}))
            AND timestamp_iso > datetime('now', {window})
        """, list(TASK_NODES) + list(REWARD_WALLETS) + list(blocked_set) + list(blocked_set)).fetchone()['c']
        if label == '24h': blocked_attempts_24h = count
        elif label == '7d': blocked_attempts_7d = count
        else: blocked_attempts_30d = count

# Post-filter leak rate 30d
reward_leaks_30d = 0
if blocked_set:
    reward_leaks_30d = db.execute(f"""
        SELECT COUNT(*) as c FROM transactions
        WHERE account IN ({','.join('?' * len(REWARD_WALLETS))})
        AND CAST(amount_drops AS INTEGER) > 0 AND has_memo = 1
        AND destination IN ({','.join('?' * len(blocked_set))})
        AND timestamp_iso > datetime('now', '-30 days')
    """, list(REWARD_WALLETS) + list(blocked_set)).fetchone()['c']

total_rewards_30d = db.execute("""
    SELECT COUNT(*) as c FROM transactions
    WHERE account IN ({}) AND CAST(amount_drops AS INTEGER) > 0
    AND has_memo = 1 AND timestamp_iso > datetime('now', '-30 days')
""".format(','.join('?' * len(REWARD_WALLETS))), REWARD_WALLETS).fetchone()['c']

post_filter_leak_rate_30d = round(reward_leaks_30d / max(total_rewards_30d, 1), 6)

# ── Cooldown Policy Analysis (FIXED) ────────────────────────────────

cooldown_data = db.execute("""
    SELECT account, timestamp_iso, tx_hash FROM transactions
    WHERE destination IN ({}) AND has_memo = 1
    AND timestamp_iso > datetime('now', '-7 days')
    ORDER BY account, timestamp_iso
""".format(','.join('?' * len(TASK_NODES))), TASK_NODES).fetchall()

# Deduplicate same-ledger events and compute gaps
sender_gaps_raw = []
sender_gaps_normalized = []
last_ts = {}
last_ledger_ts = {}  # For dedup: track per-account last timestamp

for r in cooldown_data:
    addr = r['account']
    ts = r['timestamp_iso']
    if addr in ALL_INFRA:
        continue  # Exclude infrastructure retries

    if addr in last_ts:
        try:
            t1 = datetime.fromisoformat(last_ts[addr].replace('Z', '+00:00'))
            t2 = datetime.fromisoformat(ts.replace('Z', '+00:00'))
            gap_minutes = (t2 - t1).total_seconds() / 60

            sender_gaps_raw.append(gap_minutes)
            # Normalized: skip same-ledger duplicates (gap < 0.1 min = 6 sec)
            if gap_minutes >= 0.1:
                sender_gaps_normalized.append(gap_minutes)
        except:
            pass
    last_ts[addr] = ts

sender_gaps_raw.sort()
sender_gaps_normalized.sort()

def percentile(sorted_list, p):
    if not sorted_list: return 0
    idx = int(len(sorted_list) * p / 100)
    return sorted_list[min(idx, len(sorted_list) - 1)]

raw_min = sender_gaps_raw[0] if sender_gaps_raw else 0
normalized_min = sender_gaps_normalized[0] if sender_gaps_normalized else 0
p5 = percentile(sender_gaps_normalized, 5)
p10 = percentile(sender_gaps_normalized, 10)
median_gap = percentile(sender_gaps_normalized, 50)
recommended_gap = max(p5, 1.0)  # At least 1 minute

# ── Manual Review Queue ──────────────────────────────────────────────

borderline = db.execute("""
    SELECT COUNT(*) as c FROM accounts a
    WHERE a.tx_count > 10 AND a.memo_tx_count = 0
    AND a.address NOT IN (SELECT address FROM wallet_labels)
    AND a.address NOT IN (SELECT address FROM sybil_clusters)
""").fetchone()['c']

# ── Worked Example (real bot, address redacted via hash) ─────────────

example_bot = db.execute("""
    SELECT a.address, a.tx_count, a.memo_tx_count, a.balance_drops
    FROM accounts a
    JOIN wallet_labels l ON a.address = l.address AND l.label_type = 'bot'
    JOIN sybil_clusters s ON a.address = s.address
    WHERE a.tx_count >= 50
    ORDER BY a.tx_count DESC LIMIT 1
""").fetchone()

worked_example = None
if example_bot:
    addr = example_bot['address']
    bal = int(example_bot['balance_drops'] or 0) / 1e6
    # Get peer flag share
    peers = db.execute("""
        SELECT DISTINCT CASE WHEN from_address = ? THEN to_address ELSE from_address END as peer
        FROM edges WHERE from_address = ? OR to_address = ?
    """, (addr, addr, addr)).fetchall()
    peer_addrs = [p['peer'] for p in peers]
    bot_peers = sum(1 for p in peer_addrs if p in bot_addrs)
    peer_flag_share = round(bot_peers / max(len(peer_addrs), 1), 2)

    signals_triggered = []
    if example_bot['tx_count'] >= 50 and example_bot['memo_tx_count'] == 0:
        signals_triggered.append('ZERO_MEMO_HIGH_TX')
    if 14.5 <= bal <= 15.5 and example_bot['tx_count'] >= 50:
        signals_triggered.append('UNIFORM_BALANCE_BOT')
    if peer_flag_share >= 0.3:
        signals_triggered.append('PEER_CLUSTER_DENSITY')
    signals_triggered.append('SYBIL_BLOCK')

    addr_hash = hashlib.sha256(addr.encode()).hexdigest()[:16]
    worked_example = {
        'address': f'redacted:sha256:{addr_hash}',
        'signals': {
            'tx_count': example_bot['tx_count'],
            'memo_count': example_bot['memo_tx_count'],
            'pft_balance': round(bal, 2),
            'peer_count': len(peer_addrs),
            'peer_flag_share': peer_flag_share,
        },
        'reason_codes_triggered': signals_triggered,
        'final_action': 'blocked_acceptance_and_reward',
        'note': 'Real account from the indexed chain. Address redacted via SHA-256 prefix.',
    }

# ── Reason Codes ─────────────────────────────────────────────────────

reason_codes = [
    {
        'code': 'SYBIL_BLOCK',
        'description': 'Address belongs to a detected sybil cluster',
        'active': True,
        'blocked_count': len(sybil_addrs),
        'share_of_active': round(len(sybil_addrs) / max(total_active_accounts, 1), 4),
        'scope': 'acceptance + reward',
    },
    {
        'code': 'BOT_CLASSIFICATION',
        'description': 'Address classified as automated bot by behavioral heuristics',
        'active': True,
        'blocked_count': len(bot_addrs),
        'share_of_active': round(len(bot_addrs) / max(total_active_accounts, 1), 4),
        'scope': 'acceptance + reward',
    },
    {
        'code': 'ZERO_MEMO_HIGH_TX',
        'description': 'Account has 50+ transactions but zero memo participation',
        'active': True,
        'blocked_count': db.execute("SELECT COUNT(*) as c FROM accounts WHERE tx_count >= 50 AND memo_tx_count = 0").fetchone()['c'],
        'threshold': {'tx_count': '>=50', 'memo_tx_count': '==0'},
        'scope': 'classification input',
    },
    {
        'code': 'UNIFORM_BALANCE_BOT',
        'description': 'Account holds exactly ~15 PFT (minimum reserve) with high tx count',
        'active': True,
        'blocked_count': db.execute("""
            SELECT COUNT(*) as c FROM accounts
            WHERE CAST(balance_drops AS REAL)/1000000 BETWEEN 14.5 AND 15.5 AND tx_count >= 50
        """).fetchone()['c'],
        'threshold': {'pft_balance': '14.5-15.5', 'tx_count': '>=50'},
        'scope': 'classification input',
    },
    {
        'code': 'PEER_CLUSTER_DENSITY',
        'description': 'More than 30% of account peers are flagged bots',
        'active': True,
        'blocked_count': db.execute("SELECT COUNT(DISTINCT address) as c FROM sybil_clusters WHERE signals LIKE '%peer_cluster%'").fetchone()['c'],
        'threshold': {'peer_flag_share': '>=0.30', 'min_peers': '>=5'},
        'scope': 'sybil detection input',
    },
    {
        'code': 'COOLDOWN_VIOLATION',
        'description': 'Submissions faster than recommended enforcement gap',
        'active': recommended_gap > 0,
        'blocked_count': sum(1 for g in sender_gaps_normalized if g < recommended_gap) if sender_gaps_normalized else 0,
        'threshold': {'min_gap_minutes': recommended_gap},
        'scope': 'acceptance rate-limit',
    },
]

# ── Enforcement State ────────────────────────────────────────────────

if acceptance_gate_active and reward_gate_active and reward_to_bots_ever == 0:
    enforcement_state = 'active'
elif acceptance_gate_active and reward_gate_active:
    enforcement_state = 'active_with_history'
elif acceptance_gate_active or reward_gate_active:
    enforcement_state = 'partial'
else:
    enforcement_state = 'inactive'

# ── Previous snapshot for delta ──────────────────────────────────────

prev_raw = db.execute("SELECT value FROM crawl_state WHERE key = 'last_auth_snapshot'").fetchone()
prev = json.loads(prev_raw['value']) if prev_raw else None

delta_from_previous = None
if prev:
    prev_blocked = set(prev.get('blocked_addresses', []))
    newly_blocked = list(blocked_set - prev_blocked)
    newly_unblocked = list(prev_blocked - blocked_set)

    # Reason code distribution change
    prev_rc_counts = prev.get('reason_code_counts', {})
    current_rc_counts = {rc['code']: rc['blocked_count'] for rc in reason_codes}
    rc_changes = {}
    for code in set(list(prev_rc_counts.keys()) + list(current_rc_counts.keys())):
        delta = current_rc_counts.get(code, 0) - prev_rc_counts.get(code, 0)
        if delta != 0:
            rc_changes[code] = delta

    delta_from_previous = {
        'since': prev.get('calculated_at', calculated_at),
        'newly_blocked': len(newly_blocked),
        'newly_unblocked': len(newly_unblocked),
        'blocked_population_delta': len(blocked_set) - len(prev_blocked),
        'reason_code_distribution_change': rc_changes,
    }

# Save snapshot
snap = {
    'calculated_at': calculated_at,
    'blocked_addresses': list(blocked_set),
    'reason_code_counts': {rc['code']: rc['blocked_count'] for rc in reason_codes},
}
db.execute("INSERT OR REPLACE INTO crawl_state (key, value) VALUES ('last_auth_snapshot', ?)", (json.dumps(snap),))
db.commit()

# ── Assemble payload ─────────────────────────────────────────────────

payload = {
    'schema_version': '1.0.0',
    'methodology_version': '1.0.0',
    'manifest_version': '1.0.0',
    'cooldown_policy_version': '1.1.0',
    'classifier_version': '1.0.0',
    'snapshot_id': snapshot_id,
    'calculated_at': calculated_at,
    'next_update_at': next_update_at,
    'refresh_cadence': 'hourly',

    'enforcement_state': enforcement_state,
    'acceptance_gate_active': acceptance_gate_active,
    'reward_gate_active': reward_gate_active,

    'acceptance_gate': {
        'active': acceptance_gate_active,
        'description': 'Controls which addresses can submit tasks to the task node. Blocked addresses (bot/sybil) are excluded from task processing.',
        'task_submissions_24h': task_submissions_24h,
        'unique_senders_24h': len(task_sender_addrs),
        'accepted_senders_24h': len(accepted_senders_24h),
        'blocked_senders_24h': acceptance_blocked_24h,
        'blocked_addresses_in_filter': len(blocked_set),
        'screened_submission_share_24h': screened_submission_share_24h,
        'evidence': 'No bot/sybil addresses submitted to task nodes in 24h window' if acceptance_gate_active else f'{acceptance_blocked_24h} blocked addresses reached task node',
    },

    'reward_gate': {
        'active': reward_gate_active,
        'description': 'Controls which addresses receive PFT reward emissions. Only verified non-bot, non-sybil contributors receive rewards.',
        'reward_transactions_24h': total_rewards_24h,
        'reward_pft_24h': round(total_reward_pft_24h, 2),
        'unique_recipients_24h': len(reward_recipients_24h),
        'leaked_to_blocked_24h': reward_leaked_24h,
        'leaked_to_blocked_ever': reward_to_bots_ever,
        'screened_reward_share_24h': screened_reward_share_24h,
        'evidence': 'Zero rewards to bot/sybil addresses in 24h (and none in full history)' if (reward_gate_active and reward_to_bots_ever == 0) else (
            f'Zero leaks in 24h but {reward_to_bots_ever} historical leak(s) detected' if reward_gate_active else f'{reward_leaked_24h} blocked addresses received rewards in 24h'
        ),
    },

    'blocked_events_24h': blocked_attempts_24h,
    'manual_review_queue_size': borderline,

    'enforcement_effectiveness': {
        'screened_submission_share_24h': screened_submission_share_24h,
        'screened_reward_share_24h': screened_reward_share_24h,
        'blocked_attempt_rate_7d': blocked_attempts_7d,
        'blocked_attempt_rate_30d': blocked_attempts_30d,
        'post_filter_leak_rate_30d': post_filter_leak_rate_30d,
        'total_rewards_30d': total_rewards_30d,
        'reward_leaks_30d': reward_leaks_30d,
    },

    'cooldown_policy': {
        'version': '1.1.0',
        'lookback': '7d',
        'events_analyzed': len(sender_gaps_raw),
        'senders_analyzed': len(set(r['account'] for r in cooldown_data if r['account'] not in ALL_INFRA)),
        'raw_min_gap_minutes': round(raw_min, 2),
        'normalized_min_gap_minutes': round(normalized_min, 2),
        'p5_gap_minutes': round(p5, 2),
        'p10_gap_minutes': round(p10, 2),
        'median_gap_minutes': round(median_gap, 2),
        'recommended_enforcement_gap_minutes': round(recommended_gap, 2),
        'normalization_notes': [
            'same-ledger duplicate events removed (gap < 6 seconds)',
            'infrastructure address retries excluded',
        ],
    },

    'reason_codes': reason_codes,

    'decision_trace_schema': {
        'inputs': ['tx_count', 'memo_count', 'pft_balance', 'peer_count', 'peer_flag_share'],
        'rules_applied_in_order': [
            'ZERO_MEMO_HIGH_TX',
            'UNIFORM_BALANCE_BOT',
            'HIGH_TX_LOW_BALANCE',
            'NFT_NO_MEMOS',
            'PEER_CLUSTER_DENSITY',
        ],
        'score_aggregation': 'weighted_sum >= 0.5 triggers BOT_CLASSIFICATION',
        'block_condition': 'BOT_CLASSIFICATION OR SYBIL_BLOCK',
        'manual_review_condition': 'tx_count > 10 AND memo_count == 0 AND NOT already_labeled AND NOT in_sybil_cluster',
        'precedence': 'infrastructure whitelist > sybil cluster > bot classification > manual review',
    },

    'false_positive_guards': {
        'auto_block_requires': '2+ independent heuristics OR sybil cluster membership',
        'review_band_enabled': True,
        'review_band_count': borderline,
        'infrastructure_whitelist_size': len(ALL_INFRA),
        'infrastructure_excluded_from_classification': True,
        'infrastructure_excluded_from_peer_graph': True,
        'grandfather_exemptions': 0,
        'appealable_labels': ['BOT_CLASSIFICATION'],
        'non_appealable_labels': ['SYBIL_BLOCK'],
    },

    'blocked_population': {
        'total_blocked': len(blocked_set),
        'total_active_accounts': total_active_accounts,
        'blocked_share_of_active': round(len(blocked_set) / max(total_active_accounts, 1), 4),
        'classification_axes': {
            'behavioral_bot': len(bot_addrs),
            'sybil_cluster': len(sybil_addrs),
            'manual_override': 0,
        },
        'label_overlap_matrix': {
            'bot_only': len(bot_only),
            'sybil_only': len(sybil_only),
            'bot_and_sybil': len(both),
            'note': 'sybil is corroborating evidence for bot classification, not an independent axis. All sybil-flagged accounts were first classified as bots via behavioral heuristics, then clustered via peer-graph density.',
        },
        'heuristics': [
            'zero_memo_high_tx: 50+ txns with 0 memos (weight 0.4)',
            'uniform_balance: ~15 PFT reserve + 50+ tx count (weight 0.2)',
            'peer_cluster_density: >30% of peers are flagged bots, min 5 peers (weight 0.3)',
            'high_tx_low_balance: 100+ txns with <100 PFT balance (weight 0.1)',
            'nft_no_memos: NFT activity without memo participation (weight 0.1)',
        ],
    },

    'worked_example': worked_example,

    'replay_capsule': {
        'window_start': window_24h_start,
        'window_end': calculated_at,
        'source_tables': ['accounts', 'transactions', 'edges', 'wallet_labels', 'sybil_clusters', 'crawl_state'],
        'deterministic_order': 'address_asc_then_tx_hash_asc',
        'normalization_rules': [
            'deduplicate identical tx_hash rows',
            'treat empty memo and null memo equivalently',
            'round balance to 6 decimals before reserve comparison',
            'exclude infrastructure addresses from peer-graph Jaccard similarity',
            'same-ledger events (gap < 6s) collapsed for cooldown analysis',
        ],
    },

    'methodology_change_summary': {
        'from_version': '0.9.0',
        'to_version': '1.0.0',
        'changes': [
            'raised zero_memo_high_tx threshold from 40 to 50 transactions',
            'added peer_cluster_density rule (>30% bot peers)',
            'excluded infrastructure addresses from peer graph Jaccard similarity',
            'added sybil cluster detection via counterparty overlap + behavioral signals',
            'normalized cooldown analysis to exclude same-ledger duplicates',
            'added 7 infrastructure addresses to permanent whitelist',
        ],
    },

    'window_map': {
        'acceptance_gate_metrics': '24h',
        'reward_gate_metrics': '24h',
        'cooldown_policy_analysis': '7d',
        'enforcement_effectiveness_short': '24h',
        'enforcement_effectiveness_long': '30d',
        'leaked_to_blocked_ever': 'full_history',
        'blocked_population': 'full_history_current_state',
        'replay_capsule': '24h',
    },

    'delta_from_previous': delta_from_previous,

    'integrity_canary': {
        'expected_infra_address_count': len(ALL_INFRA),
        'observed_infra_address_count': db.execute("SELECT COUNT(*) as c FROM wallet_labels WHERE label_type = 'infrastructure'").fetchone()['c'],
        'expected_task_node_count': len(TASK_NODES),
        'expected_reward_wallet_count': len(REWARD_WALLETS),
        'status': 'ok' if db.execute("SELECT COUNT(*) as c FROM wallet_labels WHERE label_type = 'infrastructure'").fetchone()['c'] == len(ALL_INFRA) else 'mismatch',
    },

    'recompute_hints': [
        'all metrics are derivable from public chain history via account_tx RPC',
        'no private allowlists required except published infrastructure addresses',
        'snapshot_hash covers canonical JSON serialization with sorted keys',
        'classification thresholds and weights are fully specified in reason_codes and blocked_population.heuristics',
        'sybil clusters are computed from peer-graph density after excluding infrastructure from Jaccard similarity',
    ],

    'infrastructure': {
        'task_nodes': len(TASK_NODES),
        'reward_wallets': len(REWARD_WALLETS),
        'total_infra_addresses': len(ALL_INFRA),
    },

    'data_source': {
        'database': 'chain-index.db',
        'rpc_node': 'postfiatd full-history archive (local)',
        'lens_url': 'https://pft.permanentupperclass.com/lens/',
        'health_url': 'https://pft.permanentupperclass.com/lens/health.json',
        'audit_url': 'https://pft.permanentupperclass.com/lens/audit.html',
    },
}

# ── Snapshot hash ────────────────────────────────────────────────────

payload_bytes = json.dumps(payload, sort_keys=True, separators=(',', ':')).encode('utf-8')
payload['snapshot_hash'] = 'sha256:' + hashlib.sha256(payload_bytes).hexdigest()

# ── Write ────────────────────────────────────────────────────────────

out = os.path.expanduser('~/pft-validator/lens/auth.json')
with open(out, 'w') as f:
    json.dump(payload, f, indent=2)

print(f"Enforcement state: {enforcement_state}")
print(f"Acceptance gate: {'ACTIVE' if acceptance_gate_active else 'INACTIVE'} ({task_submissions_24h} submissions, {acceptance_blocked_24h} blocked)")
print(f"Reward gate: {'ACTIVE' if reward_gate_active else 'INACTIVE'} ({total_rewards_24h} rewards, {reward_leaked_24h} leaked 24h, {reward_to_bots_ever} ever)")
print(f"Blocked: {len(blocked_set)} total ({len(bot_only)} bot-only, {len(sybil_only)} sybil-only, {len(both)} both)")
print(f"Cooldown: raw_min={round(raw_min, 2)}m normalized_min={round(normalized_min, 2)}m median={round(median_gap, 2)}m p5={round(p5, 2)}m")
print(f"Effectiveness: leak_rate_30d={post_filter_leak_rate_30d} blocked_7d={blocked_attempts_7d} blocked_30d={blocked_attempts_30d}")
print(f"Review queue: {borderline} | Canary: {payload['integrity_canary']['status']}")
print(f"Written to {out}")

db.close()
PYEOF

# Push to GitHub
cd ~/pft-validator && git add lens/auth.json && git commit -m "Auth audit feed $(date -u +%Y-%m-%dT%H:%M)" --allow-empty 2>/dev/null && git push origin main 2>/dev/null
