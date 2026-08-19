#!/bin/bash
# Export subs.json — SUBS Protocol Service Registry
# Hourly export: seeded services + on-chain registrations + live subscriber counts

python3 << 'PYEOF'
import sqlite3, json, os, hashlib
from datetime import datetime, timezone, timedelta

db = sqlite3.connect(os.path.expanduser('~/.pf-scout/chain-index.db'))
db.row_factory = sqlite3.Row

now = datetime.now(timezone.utc)
exported_at = now.strftime('%Y-%m-%dT%H:%M:%SZ')

# ── Protocol config ──────────────────────────────────────────────────

PROTOCOL_ADDRESS = "r9XYDxJDbmmhSGNpUguVhea6xn3Tu2HbeF"  # SUBS protocol address (dedicated wallet)
TREASURY_ADDRESS = "rsS2Y6CK9dz9dVFjJvRyD2gBdoLPqjaXRZ"  # Operator
FEE_BPS = 250  # 2.5%

# ── Seeded services (hardcoded until on-chain registration is live) ──

SEEDED_SERVICES = [
    {
        "service_id": "herald",
        "name": "The Hive Herald",
        "description": "Daily intelligence briefing delivered to your inbox and available at pft.permanentupperclass.com/herald/. Flow tracking, contributor movers, sybil watch, full-history deep cuts. The newspaper of the Post Fiat colony.",
        "url": "https://pft.permanentupperclass.com/herald/",
        "preview_image": "/herald/edition-preview.jpg",
        "provider": "Permanent Upper Class",
        "provider_address": "rsS2Y6CK9dz9dVFjJvRyD2gBdoLPqjaXRZ",
        "service_address": "r9XYDxJDbmmhSGNpUguVhea6xn3Tu2HbeF",
        "price_pft": 1000,
        "price_drops": 1000000000,
        "period_days": 30,
        "features": [
            "Daily intelligence briefing delivered on-chain",
            "Flow of Capital: reward tracking, top earners, distribution analysis",
            "Movers: rising contributors, new wallets, gone-quiet alerts",
            "Sybil Watch: bot detection, enforcement state, review queue",
            "Deep Cut: full-history archive exclusives only we can produce",
            "Historical archive access at /herald/{date}"
        ],
        "free_features": [
            "Pulse: network health, wallet count, memo velocity"
        ],
        "status": "active",
        "verified": True,
        "registered_at": "2026-04-14T00:00:00Z",
    },
]

# ── Compute live subscriber counts per service ───────────────────────

services = []
for svc in SEEDED_SERVICES:
    service_id = svc["service_id"]
    price_drops = svc["price_drops"]
    period_days = svc["period_days"]

    # Task node encrypts memos (memo_type='keystone'), so we match subscription
    # payments by amount: any payment of >= price_drops to the protocol address
    # is treated as a subscription to the service matching that price.
    # This works as long as each service has a unique price.

    active_subs = db.execute("""
        SELECT COUNT(DISTINCT account) as c
        FROM transactions
        WHERE destination = ?
          AND CAST(amount_drops AS INTEGER) >= ?
          AND CAST(amount_drops AS INTEGER) < ?
          AND tx_type = 'Payment'
          AND account != ?
          AND timestamp_iso > datetime('now', ?)
    """, (PROTOCOL_ADDRESS, price_drops, price_drops + 1000000, PROTOCOL_ADDRESS, f'-{period_days} days')).fetchone()['c']

    rev_30d = db.execute("""
        SELECT COALESCE(SUM(CAST(amount_drops AS INTEGER)), 0) as total
        FROM transactions
        WHERE destination = ?
          AND CAST(amount_drops AS INTEGER) >= ?
          AND CAST(amount_drops AS INTEGER) < ?
          AND tx_type = 'Payment'
          AND account != ?
          AND timestamp_iso > datetime('now', '-30 days')
    """, (PROTOCOL_ADDRESS, price_drops, price_drops + 1000000, PROTOCOL_ADDRESS)).fetchone()['total']

    lifetime_subs = db.execute("""
        SELECT COUNT(DISTINCT account) as c
        FROM transactions
        WHERE destination = ?
          AND CAST(amount_drops AS INTEGER) >= ?
          AND CAST(amount_drops AS INTEGER) < ?
          AND tx_type = 'Payment'
          AND account != ?
    """, (PROTOCOL_ADDRESS, price_drops, price_drops + 1000000, PROTOCOL_ADDRESS)).fetchone()['c']

    svc_out = dict(svc)
    svc_out["subscribers_active"] = active_subs
    svc_out["subscribers_lifetime"] = lifetime_subs
    svc_out["revenue_30d_pft"] = round(rev_30d / 1e6, 2)
    svc_out["revenue_30d_protocol_fee_pft"] = round(rev_30d / 1e6 * FEE_BPS / 10000, 2)
    services.append(svc_out)

# ── Index freshness ──────────────────────────────────────────────────

last_crawl = db.execute("SELECT value FROM crawl_state WHERE key = 'last_crawl_at'").fetchone()
index_freshness = last_crawl['value'] if last_crawl else None

# ── Assemble payload ─────────────────────────────────────────────────

payload = {
    "schema_version": "1.0.0",
    "exported_at": exported_at,
    "index_freshness": index_freshness,
    "protocol_address": PROTOCOL_ADDRESS,
    "treasury_address": TREASURY_ADDRESS,
    "protocol_fee_bps": FEE_BPS,
    "protocol_fee_pct": "2.5%",
    "services": services,
    "bundles": [],
    "protocol": {
        "memo_type_subscribe": "subs.subscribe",
        "memo_type_register": "subs.register",
        "memo_type_forward": "subs.forward",
        "verification_method": "canonical_chain_query",
        "payment_semantics": "one_payment_one_period",
        "cancellation": "non_renewal",
        "rounding_policy": "floor",
        "spec_url": "https://github.com/P-U-C/pft-validator/blob/main/subs-protocol.md",
    },
    "stats": {
        "total_services": len(services),
        "total_active_subscriptions": sum(s["subscribers_active"] for s in services),
        "total_revenue_30d_pft": sum(s["revenue_30d_pft"] for s in services),
        "total_protocol_revenue_30d_pft": sum(s["revenue_30d_protocol_fee_pft"] for s in services),
    },
}

# ── Write ────────────────────────────────────────────────────────────

out = os.path.expanduser('~/pft-validator/lens/subs.json')
with open(out, 'w') as f:
    json.dump(payload, f, indent=2)

print(f"Services: {len(services)}")
for s in services:
    print(f"  {s['service_id']}: {s['subscribers_active']} active, {s['revenue_30d_pft']} PFT rev")
print(f"Written to {out}")

db.close()
PYEOF

# Push to GitHub
cd ~/pft-validator && git add lens/subs.json && git commit -m "SUBS registry $(date -u +%Y-%m-%dT%H:%M)" --allow-empty 2>/dev/null && git push origin main 2>/dev/null
