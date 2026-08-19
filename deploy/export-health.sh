#!/bin/bash
# Export health.json — Hourly Network Health Snapshot API
# Canonical deterministic health contract for the Post Fiat network.
# Deterministic composite score + anomaly flags from chain-index.db

python3 << 'PYEOF'
import sqlite3, json, os, hashlib
from datetime import datetime, timezone, timedelta

db = sqlite3.connect(os.path.expanduser('~/.pf-scout/chain-index.db'))
db.row_factory = sqlite3.Row

now = datetime.now(timezone.utc)
calculated_at = now.strftime('%Y-%m-%dT%H:%M:%SZ')
snapshot_id = now.replace(minute=0, second=0, microsecond=0).strftime('%Y-%m-%dT%H:%M:%SZ')
next_update_at = (now + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0).strftime('%Y-%m-%dT%H:%M:%SZ')

# ── Raw counts ───────────────────────────────────────────────────────

total_accounts = db.execute("SELECT COUNT(*) as c FROM accounts WHERE tx_count > 0").fetchone()['c']
bot_accounts = db.execute("SELECT COUNT(*) as c FROM wallet_labels WHERE label_type = 'bot'").fetchone()['c']
infra_accounts = db.execute("SELECT COUNT(*) as c FROM wallet_labels WHERE label_type = 'infrastructure'").fetchone()['c']
contributor_accounts = total_accounts - bot_accounts - infra_accounts

total_edges = db.execute("SELECT COUNT(*) as c FROM edges WHERE tx_count > 0").fetchone()['c']
bidir_edges = db.execute("""
    SELECT COUNT(*) as c FROM edges e1
    WHERE EXISTS (SELECT 1 FROM edges e2 WHERE e2.from_address = e1.to_address AND e2.to_address = e1.from_address AND e2.tx_count > 0)
    AND e1.tx_count > 0
""").fetchone()['c']

total_txns = db.execute("SELECT COUNT(*) as c FROM transactions").fetchone()['c']
memo_txns = db.execute("SELECT COUNT(*) as c FROM transactions WHERE has_memo = 1").fetchone()['c']

sybil_clusters = db.execute("SELECT COUNT(DISTINCT cluster_id) as c FROM sybil_clusters").fetchone()['c']
sybil_accounts = db.execute("SELECT COUNT(DISTINCT address) as c FROM sybil_clusters").fetchone()['c']

# ── Normalization bounds ─────────────────────────────────────────────

NORM = {
    'concentration_hhi_bad': 0.5,
    'concentration_hhi_good': 0.05,
    'contributor_ratio_target': 0.6,
    'bidirectional_ratio_target': 0.5,
    'sybil_ratio_max': 0.3,
    'velocity_drop_threshold': 0.5,
    'bot_cluster_threshold': 0.4,
    'concentration_shock_threshold': 0.35,
    'contributor_exodus_threshold': 0.25,
}

# ── Component Metric 1: Concentration (HHI) ─────────────────────────

accounts = db.execute("SELECT memo_tx_count FROM accounts WHERE tx_count > 0 AND memo_tx_count > 0").fetchall()
total_memos = sum(a['memo_tx_count'] for a in accounts) or 1
hhi = sum((a['memo_tx_count'] / total_memos) ** 2 for a in accounts)

concentration_score = max(0.0, min(1.0, (NORM['concentration_hhi_bad'] - hhi) / (NORM['concentration_hhi_bad'] - NORM['concentration_hhi_good'])))

# ── Component Metric 2: Contributor Ratio ────────────────────────────

contributor_ratio = contributor_accounts / max(total_accounts, 1)
contributor_ratio_score = max(0.0, min(1.0, contributor_ratio / NORM['contributor_ratio_target']))

# ── Component Metric 3: Memo Velocity ────────────────────────────────

daily_counts = db.execute("""
    SELECT SUBSTR(timestamp_iso, 1, 10) as day, COUNT(*) as c
    FROM transactions WHERE has_memo = 1 AND timestamp_iso != ''
    GROUP BY day ORDER BY day DESC LIMIT 8
""").fetchall()

if len(daily_counts) >= 2:
    latest_day_count = daily_counts[0]['c']
    avg_7d = sum(d['c'] for d in daily_counts[1:]) / max(len(daily_counts) - 1, 1)
    velocity_ratio = latest_day_count / max(avg_7d, 1)
    memo_velocity_score = max(0.0, min(1.0, velocity_ratio))
else:
    latest_day_count = daily_counts[0]['c'] if daily_counts else 0
    avg_7d = latest_day_count
    velocity_ratio = 1.0
    memo_velocity_score = 0.5

# ── Component Metric 4: Bidirectional Growth ─────────────────────────

bidir_ratio = bidir_edges / max(total_edges, 1)
bidirectional_growth_score = max(0.0, min(1.0, bidir_ratio / NORM['bidirectional_ratio_target']))

# ── Component Metric 5: Sybil Prevalence ────────────────────────────

sybil_ratio = sybil_accounts / max(total_accounts, 1)
sybil_prevalence_score = max(0.0, min(1.0, 1.0 - (sybil_ratio / NORM['sybil_ratio_max'])))

# ── Composite Health Score ───────────────────────────────────────────

weights = {
    'concentration': 0.20,
    'contributor_ratio': 0.25,
    'memo_velocity': 0.20,
    'bidirectional_growth': 0.15,
    'sybil_prevalence': 0.20,
}

component_scores = {
    'concentration': round(concentration_score, 4),
    'contributor_ratio': round(contributor_ratio_score, 4),
    'memo_velocity': round(memo_velocity_score, 4),
    'bidirectional_growth': round(bidirectional_growth_score, 4),
    'sybil_prevalence': round(sybil_prevalence_score, 4),
}

health_score = round(sum(component_scores[k] * weights[k] for k in weights), 4)

# ── Component Metrics Detail (with contribution) ────────────────────

component_metrics = {
    'concentration': {
        'score': component_scores['concentration'],
        'weight': weights['concentration'],
        'contribution': round(component_scores['concentration'] * weights['concentration'], 4),
        'raw_hhi': round(hhi, 6),
        'formula': 'max(0, min(1, (hhi_bad - HHI) / (hhi_bad - hhi_good)))',
        'description': 'Herfindahl-Hirschman Index of memo activity distribution. Lower HHI = more distributed = healthier.',
    },
    'contributor_ratio': {
        'score': component_scores['contributor_ratio'],
        'weight': weights['contributor_ratio'],
        'contribution': round(component_scores['contributor_ratio'] * weights['contributor_ratio'], 4),
        'raw_ratio': round(contributor_ratio, 4),
        'contributors': contributor_accounts,
        'total_active': total_accounts,
        'formula': 'max(0, min(1, contributor_count / total_active / target))',
        'description': 'Fraction of active accounts that are real contributors (not bots or infrastructure).',
    },
    'memo_velocity': {
        'score': component_scores['memo_velocity'],
        'weight': weights['memo_velocity'],
        'contribution': round(component_scores['memo_velocity'] * weights['memo_velocity'], 4),
        'latest_day_memos': latest_day_count,
        'avg_7d_daily': round(avg_7d, 1),
        'velocity_ratio': round(velocity_ratio, 4),
        'formula': 'max(0, min(1, latest_day_count / avg_7d_daily))',
        'description': 'Latest day memo count vs 7-day rolling average. Detects activity drops.',
    },
    'bidirectional_growth': {
        'score': component_scores['bidirectional_growth'],
        'weight': weights['bidirectional_growth'],
        'contribution': round(component_scores['bidirectional_growth'] * weights['bidirectional_growth'], 4),
        'bidirectional_edges': bidir_edges,
        'total_edges': total_edges,
        'raw_ratio': round(bidir_ratio, 4),
        'formula': 'max(0, min(1, bidir_edges / total_edges / target))',
        'description': 'Fraction of edges where both parties communicate. Higher = more collaborative.',
    },
    'sybil_prevalence': {
        'score': component_scores['sybil_prevalence'],
        'weight': weights['sybil_prevalence'],
        'contribution': round(component_scores['sybil_prevalence'] * weights['sybil_prevalence'], 4),
        'sybil_accounts': sybil_accounts,
        'sybil_clusters': sybil_clusters,
        'raw_ratio': round(sybil_ratio, 4),
        'formula': 'max(0, min(1, 1 - sybil_ratio / sybil_ratio_max))',
        'description': 'Inverse of sybil-flagged account ratio. Fewer sybils = healthier.',
    },
}

# ── Input Windows ────────────────────────────────────────────────────

input_windows = {
    'concentration': {'window': 'current_snapshot', 'description': 'All accounts with memo_tx_count > 0 at snapshot time'},
    'contributor_ratio': {'window': 'current_snapshot', 'description': 'All active accounts minus bot/infra labels at snapshot time'},
    'memo_velocity': {'latest_bucket': '24h', 'baseline': '7d', 'description': 'Latest calendar day vs prior 7 calendar days rolling average'},
    'bidirectional_growth': {'window': 'full_index', 'description': 'All edges in the index with tx_count > 0'},
    'sybil_prevalence': {'window': 'current_snapshot', 'description': 'All accounts in sybil_clusters table at snapshot time'},
}

# ── Anomaly Flags (with category, operator, lookback) ────────────────

anomaly_flags = []

# Rule 1: CONCENTRATION_SHOCK
conc_threshold = NORM['concentration_shock_threshold']
conc_triggered = hhi > conc_threshold
anomaly_flags.append({
    'rule': 'CONCENTRATION_SHOCK',
    'category': 'concentration',
    'status': 'triggered' if conc_triggered else 'clear',
    'severity': 'high' if conc_triggered else 'none',
    'operator': '>',
    'threshold': conc_threshold,
    'current_value': round(hhi, 4),
    'lookback': 'current_snapshot',
    'reason': f'HHI={round(hhi, 4)} {"exceeds" if conc_triggered else "below"} threshold {conc_threshold}. '
              + ('Top accounts hold disproportionate memo share.' if conc_triggered else 'Memo activity is reasonably distributed.'),
})

# Rule 2: BOT_CLUSTER_GROWTH
bot_threshold = NORM['bot_cluster_threshold']
bot_ratio = bot_accounts / max(total_accounts, 1)
bot_triggered = bot_ratio > bot_threshold
anomaly_flags.append({
    'rule': 'BOT_CLUSTER_GROWTH',
    'category': 'sybil',
    'status': 'triggered' if bot_triggered else 'clear',
    'severity': 'high' if bot_triggered else 'none',
    'operator': '>',
    'threshold': bot_threshold,
    'current_value': round(bot_ratio, 4),
    'lookback': 'current_snapshot',
    'reason': f'Bot ratio={round(bot_ratio * 100, 1)}% ({bot_accounts}/{total_accounts}) {"exceeds" if bot_triggered else "below"} {int(bot_threshold * 100)}% threshold. '
              + (f'{sybil_clusters} sybil cluster(s) detected.' if bot_triggered else f'{bot_accounts} bots identified but within tolerance.'),
})

# Rule 3: VELOCITY_DROP
vel_threshold = NORM['velocity_drop_threshold']
vel_triggered = velocity_ratio < vel_threshold and len(daily_counts) >= 2
anomaly_flags.append({
    'rule': 'VELOCITY_DROP',
    'category': 'activity',
    'status': 'triggered' if vel_triggered else 'clear',
    'severity': 'medium' if vel_triggered else 'none',
    'operator': '<',
    'threshold': vel_threshold,
    'current_value': round(velocity_ratio, 4),
    'lookback': '7d',
    'reason': f'Today={latest_day_count} memos vs 7d avg={round(avg_7d, 1)} (ratio={round(velocity_ratio, 2)}). '
              + (f'Activity dropped below {int(vel_threshold * 100)}% of normal.' if vel_triggered else 'Memo velocity is within normal range.'),
})

# Rule 4: NEW_SYBIL_CLUSTER
recent_sybil = db.execute("""
    SELECT COUNT(DISTINCT cluster_id) as c FROM sybil_clusters
    WHERE detected_at > datetime('now', '-24 hours')
""").fetchone()['c']
sybil_triggered = recent_sybil > 0
anomaly_flags.append({
    'rule': 'NEW_SYBIL_CLUSTER',
    'category': 'sybil',
    'status': 'triggered' if sybil_triggered else 'clear',
    'severity': 'high' if sybil_triggered else 'none',
    'operator': '>=',
    'threshold': 1,
    'current_value': recent_sybil,
    'lookback': '24h',
    'reason': f'{recent_sybil} cluster(s) with new detections in last 24h. '
              + ('New coordinated activity detected.' if sybil_triggered else 'No new sybil activity.'),
})

# Rule 5: CONTRIBUTOR_EXODUS
exodus_threshold = NORM['contributor_exodus_threshold']
exodus_triggered = contributor_ratio < exodus_threshold
anomaly_flags.append({
    'rule': 'CONTRIBUTOR_EXODUS',
    'category': 'participation',
    'status': 'triggered' if exodus_triggered else 'clear',
    'severity': 'high' if exodus_triggered else 'none',
    'operator': '<',
    'threshold': exodus_threshold,
    'current_value': round(contributor_ratio, 4),
    'lookback': 'current_snapshot',
    'reason': f'Contributor ratio={round(contributor_ratio * 100, 1)}% ({contributor_accounts}/{total_accounts}). '
              + (f'Real contributors below {int(exodus_threshold * 100)}% — network dominated by bots/infra.' if exodus_triggered else 'Contributor base is healthy.'),
})

# ── Previous snapshot for deltas + score_change ──────────────────────

prev_raw = db.execute("SELECT value FROM crawl_state WHERE key = 'last_health_snapshot'").fetchone()
prev = json.loads(prev_raw['value']) if prev_raw else None

deltas = None
score_change = None

if prev:
    deltas = {
        'health_score': round(health_score - prev.get('health_score', health_score), 4),
        'accounts': total_accounts - prev.get('total_accounts', total_accounts),
        'memo_transactions': memo_txns - prev.get('memo_transactions', memo_txns),
        'edges': total_edges - prev.get('total_edges', total_edges),
        'since': prev.get('calculated_at', calculated_at),
    }

    # Score change decomposition — largest movers
    prev_components = prev.get('component_scores', {})
    movers = []
    for k in component_scores:
        prev_score = prev_components.get(k, component_scores[k])
        delta = round(component_scores[k] - prev_score, 4)
        if delta != 0:
            weighted_delta = round(delta * weights[k], 4)
            # Generate reason from raw values
            if k == 'memo_velocity':
                reason = f'latest_day_memos={latest_day_count} vs prior avg={round(avg_7d, 1)}'
            elif k == 'concentration':
                reason = f'HHI moved to {round(hhi, 4)}'
            elif k == 'contributor_ratio':
                reason = f'contributor ratio={round(contributor_ratio * 100, 1)}% ({contributor_accounts}/{total_accounts})'
            elif k == 'bidirectional_growth':
                reason = f'bidir ratio={round(bidir_ratio * 100, 1)}% ({bidir_edges}/{total_edges})'
            elif k == 'sybil_prevalence':
                reason = f'sybil ratio={round(sybil_ratio * 100, 1)}% ({sybil_accounts}/{total_accounts})'
            else:
                reason = f'score moved from {prev_score} to {component_scores[k]}'
            movers.append({
                'component': k,
                'delta': weighted_delta,
                'raw_delta': delta,
                'reason': reason,
            })

    movers.sort(key=lambda m: abs(m['delta']), reverse=True)

    score_change = {
        'vs_prior_snapshot': round(health_score - prev.get('health_score', health_score), 4),
        'prior_health_score': prev.get('health_score'),
        'prior_calculated_at': prev.get('calculated_at'),
        'largest_movers': movers[:3],
    }

# Save current snapshot for next delta (include component_scores for decomposition)
snap = {
    'health_score': health_score,
    'total_accounts': total_accounts,
    'memo_transactions': memo_txns,
    'total_edges': total_edges,
    'calculated_at': calculated_at,
    'component_scores': dict(component_scores),
}
db.execute("INSERT OR REPLACE INTO crawl_state (key, value) VALUES ('last_health_snapshot', ?)", (json.dumps(snap),))
db.commit()

# ── Assemble payload ─────────────────────────────────────────────────

triggered_count = sum(1 for f in anomaly_flags if f['status'] == 'triggered')

payload = {
    'schema_version': '1.0.0',
    'methodology_version': '1.0.0',
    'classifier_version': '1.0.0',
    'scoring_weights_version': '1.0.0',
    'anomaly_rules_version': '1.0.0',
    'snapshot_id': snapshot_id,
    'calculated_at': calculated_at,
    'next_update_at': next_update_at,
    'refresh_cadence': 'hourly',
    'health_score': health_score,
    'health_score_formula': 'sum(component.score * component.weight)',
    'health_grade': 'A' if health_score >= 0.8 else ('B' if health_score >= 0.6 else ('C' if health_score >= 0.4 else ('D' if health_score >= 0.2 else 'F'))),
    'component_metrics': component_metrics,
    'input_windows': input_windows,
    'normalization': NORM,
    'anomaly_flags': anomaly_flags,
    'anomaly_summary': {
        'total_rules': len(anomaly_flags),
        'triggered': triggered_count,
        'clear': len(anomaly_flags) - triggered_count,
    },
    'score_change': score_change,
    'network_summary': {
        'total_accounts': total_accounts,
        'contributors': contributor_accounts,
        'bots': bot_accounts,
        'infrastructure': infra_accounts,
        'total_transactions': total_txns,
        'memo_transactions': memo_txns,
        'total_edges': total_edges,
        'bidirectional_edges': bidir_edges,
        'sybil_clusters': sybil_clusters,
        'sybil_accounts': sybil_accounts,
    },
    'deltas': deltas,
    'data_source': {
        'database': 'chain-index.db',
        'rpc_node': 'postfiatd full-history archive (local)',
        'methodology': 'deterministic on-chain behavioral heuristics',
        'lens_url': 'https://pft.permanentupperclass.com/lens/',
        'audit_url': 'https://pft.permanentupperclass.com/lens/audit.html',
    },
}

# ── Snapshot hash (tamper-evident) ───────────────────────────────────

# Hash the payload deterministically (sorted keys, no snapshot_hash yet)
payload_bytes = json.dumps(payload, sort_keys=True, separators=(',', ':')).encode('utf-8')
payload['snapshot_hash'] = 'sha256:' + hashlib.sha256(payload_bytes).hexdigest()

# ── Write ────────────────────────────────────────────────────────────

out = os.path.expanduser('~/pft-validator/lens/health.json')
with open(out, 'w') as f:
    json.dump(payload, f, indent=2)

print(f"Health score: {health_score} ({payload['health_grade']})")
print(f"Snapshot: {snapshot_id} hash={payload['snapshot_hash'][:20]}...")
print(f"Anomalies: {triggered_count}/{len(anomaly_flags)} triggered")
for flag in anomaly_flags:
    status = 'TRIGGERED' if flag['status'] == 'triggered' else 'clear'
    print(f"  {flag['rule']} [{flag['category']}]: {status}")
if score_change and score_change['vs_prior_snapshot'] != 0:
    print(f"Score change: {score_change['vs_prior_snapshot']:+.4f}")
    for m in score_change['largest_movers'][:2]:
        print(f"  {m['component']}: {m['delta']:+.4f} ({m['reason']})")
print(f"Written to {out}")

db.close()
PYEOF

# Push to GitHub
cd ~/pft-validator && git add lens/health.json && git commit -m "Health snapshot $(date -u +%Y-%m-%dT%H:%M)" --allow-empty 2>/dev/null && git push origin main 2>/dev/null
