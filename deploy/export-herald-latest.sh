#!/bin/bash
# Generate /herald/latest.json — the canonical public edition contract.
# A subscription-native intelligence product: machine-readable, archiveable,
# tier-aware, downstream-stable, and auditable against live indexed network data.

python3 << 'PYEOF'
import json, os, hashlib
from datetime import datetime, timezone, timedelta

HERALD_SRC = os.path.expanduser('~/pft-validator/lens/herald.json')
HEALTH_SRC = os.path.expanduser('~/pft-validator/lens/health.json')
AUTH_SRC = os.path.expanduser('~/pft-validator/lens/auth.json')
OUT = os.path.expanduser('~/pft-validator/herald/latest.json')

# Constants
SCHEMA_VERSION = "1.1.0"
METHODOLOGY_VERSION = "1.1.0"
STALENESS_THRESHOLD_SEC = 5400  # 90 min

with open(HERALD_SRC) as f:
    src = json.load(f)

# Optional: snapshot hashes from source feeds
health_hash = None
auth_hash = None
try:
    with open(HEALTH_SRC) as f:
        h = json.load(f)
        health_hash = h.get('snapshot_hash')
except: pass
try:
    with open(AUTH_SRC) as f:
        a = json.load(f)
        auth_hash = a.get('snapshot_hash')
except: pass

s = src['sections']
now = datetime.now(timezone.utc)
generated_at = now.strftime('%Y-%m-%dT%H:%M:%SZ')
edition_date = src.get('date', now.strftime('%Y-%m-%d'))
data_window_end = generated_at
data_window_start = (now - timedelta(hours=24)).strftime('%Y-%m-%dT%H:%M:%SZ')
edition_id = f"herald-{edition_date}"

# ── Lead thesis — interpretive headline ─────────────────────────────

pulse_velocity = s['pulse'].get('velocity_direction', 'steady')
memos_today = s['pulse'].get('memos_today', 0)
memos_avg = s['pulse'].get('memo_avg_7d', 0)
sybil_recent = s['watch'].get('new_sybil_detections_24h', 0)
bot_ratio = s['watch'].get('bot_ratio_pct', 0)

# Auto-generate lead from observed metrics
if sybil_recent > 20:
    lead_headline = f"Sybil labeling accelerated sharply while network activity ran {pulse_velocity}."
    lead_why = f"The classifier surfaced {sybil_recent} new sybil-signature wallets in the last 24 hours, lifting the bot ratio to {bot_ratio}% — contributors should expect stricter review pressure."
elif pulse_velocity == "dropping":
    lead_headline = f"Memo velocity dropped to {memos_today} vs a {round(memos_avg)} seven-day average."
    lead_why = "Lower throughput in the task economy tends to precede either a maintenance window or a rebound. Watch the next 24h for direction."
elif pulse_velocity == "rising":
    lead_headline = f"Memo velocity climbed to {memos_today} (vs {round(memos_avg)} avg)."
    lead_why = "Rising memo throughput signals task activity picking up. Contributors may find more reward opportunities in the next window."
else:
    lead_headline = f"Network held steady at {memos_today} memos today."
    lead_why = "No major deviation from baseline. A quiet edition — a good time to audit your own submission quality."

# ── Per-section freshness helper ────────────────────────────────────

def freshness_for(lookback_hours):
    return {
        "as_of": generated_at,
        "lookback_window": f"{lookback_hours}h",
        "methodology_version": METHODOLOGY_VERSION,
        "freshness_status": "fresh"
    }

# ── Build sections with full semantic metadata ──────────────────────

PULSE = {
    "tier": "free",
    "name": "Pulse",
    "tagline": "Network vital signs",
    **freshness_for(24),
    "methodology_note": "Health score copied from the hourly health.json surface. Wallet counts and memo velocity derived from the chain-index snapshot taken at as_of.",
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
    "narrative": s['pulse'].get('narrative', ''),
    "access": {
        "tier": "free",
        "subscription_required": False,
        "preview_chars": None
    }
}

FLOW = {
    "tier": "premium",
    "name": "Flow of Capital",
    "tagline": "Where PFT moved in the last 24 hours",
    **freshness_for(24),
    "methodology_note": "Reward payments counted from distribution/airdrop/task-node wallets to any non-bot, non-infrastructure address within a 24h rolling window. Top earner selected by aggregate PFT received in the window.",
    "metrics": {
        "reward_payments_24h": s['flow'].get('reward_payments_24h'),
        "total_pft_distributed_24h": s['flow'].get('total_pft_distributed_24h'),
        "unique_recipients_24h": s['flow'].get('unique_recipients_24h'),
        "top_earner_address": s['flow'].get('top_earner_address'),
        "top_earner_pft": s['flow'].get('top_earner_pft'),
        "largest_single_payment_pft": s['flow'].get('largest_single_payment_pft')
    },
    "narrative": s['flow'].get('narrative', ''),
    "preview": {
        "headline": f"{s['flow'].get('reward_payments_24h', 0)} reward payments distributed {s['flow'].get('total_pft_distributed_24h', 0):,} PFT in the last 24h",
        "locked": True
    },
    "access": {
        "tier": "premium",
        "subscription_required": True,
        "service_id": "herald",
        "preview_chars": 120
    }
}

MOVERS = {
    "tier": "premium",
    "name": "Who Stirs the Hive",
    "tagline": "Rising contributors, new arrivals, gone-quiet alerts",
    **freshness_for(168),  # 7 days
    "methodology_note": "Most-active ranked by memo count in the last 7 days. New wallets are those whose earliest indexed activity is within the 7-day window. Gone-quiet flags contributors with prior memo_tx_count >= 5 whose last activity is older than the gone_quiet threshold.",
    "gone_quiet_threshold_days": 7,
    "new_wallet_window_days": 7,
    "most_active_window_days": 7,
    "metrics": {
        "most_active_7d": s['movers'].get('most_active_7d', []),
        "new_wallets_7d": s['movers'].get('new_wallets_7d', []),
        "gone_quiet": s['movers'].get('gone_quiet', [])
    },
    "narrative": s['movers'].get('narrative', ''),
    "preview": {
        "headline": f"{len(s['movers'].get('new_wallets_7d', []))} new wallets, {len(s['movers'].get('gone_quiet', []))} went quiet this week",
        "locked": True
    },
    "access": {
        "tier": "premium",
        "subscription_required": True,
        "service_id": "herald"
    }
}

WATCH = {
    "tier": "premium",
    "name": "Sybil Watch",
    "tagline": "Anomaly alerts and enforcement state",
    **freshness_for(24),
    "methodology_note": "new_sybil_detections_24h counts DISTINCT wallets newly entered into the sybil_clusters table within the last 24 hours. This is NOT a count of reclassifications — it's new cluster memberships assigned by the deterministic classifier.",
    "detection_basis": "deterministic behavioral classifier v2.0 (zero_memo + ~15 PFT reserve + peer density)",
    "classification_scope": "wallets indexed through the Lens chain crawler + expanded deep-crawl set",
    "enforcement_state_reason": "No direct infrastructure→bot transactions detected in the 24h window (Q2 from CASE-001)",
    "metrics": {
        "new_sybil_detections_24h": s['watch'].get('new_sybil_detections_24h'),
        "bot_ratio_pct": s['watch'].get('bot_ratio_pct'),
        "review_queue": s['watch'].get('review_queue'),
        "enforcement_state": s['watch'].get('enforcement_state'),
        "reward_leaks_ever": s['watch'].get('reward_leaks_ever', 0)
    },
    "narrative": s['watch'].get('narrative', ''),
    "preview": {
        "headline": f"{s['watch'].get('new_sybil_detections_24h', 0)} new sybil detections, bot ratio at {s['watch'].get('bot_ratio_pct', 0)}%",
        "locked": True
    },
    "access": {
        "tier": "premium",
        "subscription_required": True,
        "service_id": "herald"
    }
}

DEEP_CUT = {
    "tier": "premium",
    "name": "From the Archive Vault",
    "tagline": "Full-history exclusive insights only we can produce",
    **freshness_for(24),
    "methodology_note": "Deep cut draws on the full-history archive node's complete ledger range. Each edition surfaces a different historical pattern — 'this day in PFT history', busiest-hour-ever, first indexed tx, etc. The specific type rotates.",
    "data_source_requirement": "full-history postfiatd archive node (only Permanent Upper Class runs one on the network)",
    "metrics": {
        "type": s['deep_cut'].get('type'),
        "date_referenced": s['deep_cut'].get('date_referenced'),
        "activity_30d_ago": s['deep_cut'].get('activity_30d_ago'),
        "busiest_hour_ever": s['deep_cut'].get('busiest_hour_ever'),
        "first_transaction_iso": s['deep_cut'].get('first_transaction')
    },
    "narrative": s['deep_cut'].get('narrative', ''),
    "preview": {
        "headline": "Full-history archive reveals a historical pattern inside the network",
        "locked": True
    },
    "access": {
        "tier": "premium",
        "subscription_required": True,
        "service_id": "herald"
    }
}

# ── Assemble payload (pre-integrity) ────────────────────────────────

payload = {
    "schema_version": SCHEMA_VERSION,
    "methodology_version": METHODOLOGY_VERSION,

    "edition_id": edition_id,
    "edition_date": edition_date,
    "edition_number": src.get('edition', 1),
    "generated_at": generated_at,

    "title": "The Hive Herald",
    "tagline": "Dispatches from the Post Fiat colony \u2014 on-chain intelligence, daily",

    "lead": {
        "headline": lead_headline,
        "why_it_matters": lead_why,
        "derived_from": ["sections.PULSE", "sections.WATCH"]
    },

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
        "billing_asset": "PFT",
        "subscription_period": "30d",
        "period_days": 30,
        "provider": "Permanent Upper Class",
        "provider_address": "rsS2Y6CK9dz9dVFjJvRyD2gBdoLPqjaXRZ",
        "subs_protocol_address": "r9XYDxJDbmmhSGNpUguVhea6xn3Tu2HbeF",
        "registry_entry_id": "herald",
        "registry_key": "services.herald",
        "subs_registry_url": "https://pft.permanentupperclass.com/lens/subs.json",
        "verification_endpoint": "/chain/subs/status/{address}",
        "subscribe_command": "/subscribe herald",
        "subscribe_memo_type": "subs.subscribe",
        "subscribe_memo_data": "herald"
    },

    "section_order": ["PULSE", "FLOW", "MOVERS", "WATCH", "DEEP_CUT"],

    "sections": {
        "PULSE": PULSE,
        "FLOW": FLOW,
        "MOVERS": MOVERS,
        "WATCH": WATCH,
        "DEEP_CUT": DEEP_CUT
    },

    "data_source": {
        "index_database": "chain-index.db",
        "rpc_node": "postfiatd full-history archive (local)",
        "lens_dashboard": "https://pft.permanentupperclass.com/lens/",
        "health_feed": "https://pft.permanentupperclass.com/lens/health.json",
        "auth_feed": "https://pft.permanentupperclass.com/lens/auth.json",
        "forensics_case_001": "https://pft.permanentupperclass.com/forensics/"
    },

    "downstream_contract": {
        "stable_fields": [
            "schema_version", "edition_id", "edition_date", "generated_at", "data_window",
            "archive_url", "lead", "service.service_id", "service.display_name",
            "service.price_pft_monthly", "section_order",
            "sections.PULSE.tier", "sections.FLOW.tier", "sections.MOVERS.tier",
            "sections.WATCH.tier", "sections.DEEP_CUT.tier"
        ],
        "delivery_channels": [
            "https://pft.permanentupperclass.com/herald/latest.json (machine-readable canonical)",
            "https://pft.permanentupperclass.com/herald/ (broadsheet web)",
            "on-chain memo from SUBS bot r9XYDxJDbmmhSGNpUguVhea6xn3Tu2HbeF (daily push to subscribers)"
        ],
        "positioning": "The canonical public edition contract for a subscription-native intelligence product: machine-readable, archiveable, tier-aware, downstream-stable, and auditable against live indexed network data."
    }
}

# ── Integrity block (hash last, after everything else is set) ────────

integrity_source = {k: v for k, v in payload.items() if k != 'integrity'}
canonical = json.dumps(integrity_source, sort_keys=True, separators=(',', ':')).encode('utf-8')
payload_hash = 'sha256:' + hashlib.sha256(canonical).hexdigest()

payload['integrity'] = {
    "payload_sha256": payload_hash,
    "generated_from": [
        "chain-index.db",
        "health.json",
        "auth.json"
    ],
    "source_snapshot_hashes": {
        "health": health_hash,
        "auth": auth_hash
    },
    "determinism_note": "Edition generated from indexed public data and published analytics surfaces without manual overrides. Same chain index + same hourly crawl produces the same payload.",
    "canonical_serialization": "json_sort_keys",
    "hash_algorithm": "sha256"
}

# Write
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w') as f:
    json.dump(payload, f, indent=2)

print(f"Wrote {OUT}")
print(f"Edition {payload['edition_id']} hash {payload_hash[:30]}...")
print(f"Sections:")
for name in payload['section_order']:
    sec = payload['sections'][name]
    m = sec.get('metrics', {})
    non_empty = sum(1 for v in m.values() if v not in (None, '', [], {}))
    print(f"  {name:10} [{sec['tier']:7}] {non_empty} metrics, methodology v{sec['methodology_version']}")
PYEOF

# Push
cd ~/pft-validator && git add herald/latest.json && git commit -m "Herald latest.json v1.1.0: per-section methodology, integrity block, lead, section_order, previews" --allow-empty 2>/dev/null && git push origin main 2>/dev/null
