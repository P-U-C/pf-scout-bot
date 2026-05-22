#!/bin/bash
# Generate /herald/latest.json — the task-contract edition feed.
# This is a stable public machine-readable route with the exact field
# names required by task 1ea70e5d (Publish First Hive Herald Edition Feed).

python3 << 'PYEOF'
import json, os
from datetime import datetime, timezone

# Reuse the rich herald.json built by export-herald.sh and reshape it
# to the task's required contract.
HERALD_SRC = os.path.expanduser('~/pft-validator/lens/herald.json')
OUT = os.path.expanduser('~/pft-validator/herald/latest.json')

with open(HERALD_SRC) as f:
    src = json.load(f)

s = src['sections']
now = datetime.now(timezone.utc)
generated_at = now.strftime('%Y-%m-%dT%H:%M:%SZ')
edition_date = src.get('date', now.strftime('%Y-%m-%d'))
data_window_end = generated_at
# Data window is the 24h covered by the edition
from datetime import timedelta
data_window_start = (now - timedelta(hours=24)).strftime('%Y-%m-%dT%H:%M:%SZ')

payload = {
    "schema_version": "1.0.0",
    "edition_date": edition_date,
    "edition_number": src.get('edition', 1),
    "generated_at": generated_at,
    "title": "The Hive Herald",
    "tagline": "Dispatches from the Post Fiat colony \u2014 on-chain intelligence, daily",

    "data_window": {
        "start": data_window_start,
        "end": data_window_end,
        "duration": "24h",
        "timezone": "UTC"
    },

    "archive_url": f"https://pft.permanentupperclass.com/herald/{edition_date}.json",
    "archive_index_url": "https://pft.permanentupperclass.com/herald/archive.html",
    "broadsheet_url": "https://pft.permanentupperclass.com/herald/",

    "service": {
        "service_id": "herald",
        "display_name": "The Hive Herald",
        "price_pft_monthly": 1000,
        "period_days": 30,
        "provider": "Permanent Upper Class",
        "provider_address": "rsS2Y6CK9dz9dVFjJvRyD2gBdoLPqjaXRZ",
        "subs_protocol_address": "r9XYDxJDbmmhSGNpUguVhea6xn3Tu2HbeF",
        "subs_registry_url": "https://pft.permanentupperclass.com/lens/subs.json",
        "subscribe_command": "/subscribe herald",
        "subscribe_memo_type": "subs.subscribe",
        "subscribe_memo_data": "herald"
    },

    "sections": {
        "PULSE": {
            "tier": "free",
            "name": "Pulse",
            "tagline": "Network vital signs",
            "metrics": {
                "health_score": s['pulse'].get('health_score'),
                "health_grade": s['pulse'].get('health_grade'),
                "total_wallets": s['pulse'].get('total_wallets'),
                "contributors": s['pulse'].get('contributors'),
                "bots": s['pulse'].get('bots'),
                "infrastructure": s['pulse'].get('infrastructure'),
                "memos_today": s['pulse'].get('memos_today'),
                "memos_yesterday": s['pulse'].get('memos_yesterday'),
                "memo_7d_daily_avg": s['pulse'].get('memo_avg_7d'),
                "velocity_direction": s['pulse'].get('velocity_direction'),
                "total_transactions": s['pulse'].get('total_transactions'),
                "total_memos": s['pulse'].get('total_memos'),
                "sybil_clusters": s['pulse'].get('sybil_clusters')
            },
            "narrative": s['pulse'].get('narrative', '')
        },

        "FLOW": {
            "tier": "premium",
            "name": "Flow of Capital",
            "tagline": "Where PFT moved in the last 24h",
            "metrics": {
                "reward_payments_24h": s['flow'].get('reward_payments_24h'),
                "total_pft_distributed_24h": s['flow'].get('total_pft_distributed_24h'),
                "unique_recipients_24h": s['flow'].get('unique_recipients_24h'),
                "top_earner_address": s['flow'].get('top_earner_address'),
                "top_earner_pft": s['flow'].get('top_earner_pft'),
                "largest_single_payment_pft": s['flow'].get('largest_single_payment_pft')
            },
            "narrative": s['flow'].get('narrative', '')
        },

        "MOVERS": {
            "tier": "premium",
            "name": "Who Stirs the Hive",
            "tagline": "Rising contributors, new arrivals, gone-quiet alerts",
            "metrics": {
                "most_active_7d": s['movers'].get('most_active_7d', []),
                "new_wallets_7d": s['movers'].get('new_wallets_7d', []),
                "gone_quiet": s['movers'].get('gone_quiet', [])
            },
            "narrative": s['movers'].get('narrative', '')
        },

        "WATCH": {
            "tier": "premium",
            "name": "Sybil Watch",
            "tagline": "Anomaly alerts and enforcement state",
            "metrics": {
                "new_sybil_detections_24h": s['watch'].get('new_sybil_detections_24h'),
                "bot_ratio_pct": s['watch'].get('bot_ratio_pct'),
                "review_queue": s['watch'].get('review_queue'),
                "enforcement_state": s['watch'].get('enforcement_state'),
                "reward_leaks_ever": s['watch'].get('reward_leaks_ever', 0)
            },
            "narrative": s['watch'].get('narrative', '')
        },

        "DEEP_CUT": {
            "tier": "premium",
            "name": "From the Archive Vault",
            "tagline": "Full-history exclusive insights only we can produce",
            "metrics": {
                "type": s['deep_cut'].get('type'),
                "date_referenced": s['deep_cut'].get('date_referenced'),
                "activity_30d_ago": s['deep_cut'].get('activity_30d_ago'),
                "busiest_hour_ever": s['deep_cut'].get('busiest_hour_ever'),
                "first_transaction_iso": s['deep_cut'].get('first_transaction')
            },
            "narrative": s['deep_cut'].get('narrative', '')
        }
    },

    "data_source": {
        "index_database": "chain-index.db",
        "rpc_node": "postfiatd full-history archive (local)",
        "lens_dashboard": "https://pft.permanentupperclass.com/lens/",
        "health_feed": "https://pft.permanentupperclass.com/lens/health.json",
        "auth_feed": "https://pft.permanentupperclass.com/lens/auth.json"
    },

    "downstream_contract": {
        "stable_fields": [
            "schema_version", "edition_date", "generated_at", "data_window",
            "archive_url", "service.service_id", "service.display_name",
            "service.price_pft_monthly", "sections.PULSE.tier", "sections.FLOW.tier",
            "sections.MOVERS.tier", "sections.WATCH.tier", "sections.DEEP_CUT.tier"
        ],
        "delivery_channels": [
            "https://pft.permanentupperclass.com/herald/latest.json (machine-readable)",
            "https://pft.permanentupperclass.com/herald/ (broadsheet web)",
            "on-chain memo from SUBS bot r9XYDxJDbmmhSGNpUguVhea6xn3Tu2HbeF (daily push to subscribers)"
        ]
    }
}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w') as f:
    json.dump(payload, f, indent=2)

print(f"Wrote {OUT}")
print(f"Edition #{payload['edition_number']} ({payload['edition_date']})")
print(f"Sections:")
for name, sec in payload['sections'].items():
    m = sec.get('metrics', {})
    non_empty = sum(1 for v in m.values() if v not in (None, '', [], {}))
    print(f"  {name:10} [{sec['tier']:7}] {non_empty} non-empty metrics")
PYEOF

# Push
cd ~/pft-validator && git add herald/latest.json && git commit -m "Herald latest.json: task-contract edition feed" --allow-empty 2>/dev/null && git remote set-url origin https://github.com/P-U-C/pft-validator.git && git push origin main 2>/dev/null && git remote set-url origin https://github.com/P-U-C/pft-validator.git
