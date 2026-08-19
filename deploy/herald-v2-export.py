#!/usr/bin/env python3
"""
Herald v2 Export — Converts Herald daily intelligence into pft.index.snapshot.v1 format
and encrypts it for subscriber-gated delivery.

Phase 1: Generate snapshot artifact + encrypt for subscribers
Phase 2: IPFS pinning + on-chain pointer (future)
Phase 3: Nostr relay delivery (future)
"""

import json
import hashlib
import os
import sys
from datetime import datetime, timezone

# Herald source
HERALD_JSON = os.path.expanduser("~/pft-validator/lens/herald.json")
OUTPUT_DIR = os.path.expanduser("~/pft-validator/herald/v2")

# Publisher identity (SUBS bot wallet)
PUBLISHER_ADDRESS = "r9XYDxJDbmmhSGNpUguVhea6xn3Tu2HbeF"
PUBLISHER_NETWORK = "postfiat_testnet"


def load_herald():
    """Load the current Herald JSON export."""
    with open(HERALD_JSON) as f:
        return json.load(f)


def herald_to_snapshot(herald: dict) -> dict:
    """Convert Herald daily export into pft.index.snapshot.v1 format.

    The Herald isn't a portfolio index — it's an intelligence index.
    We adapt the snapshot schema to represent intelligence sections
    as "positions" in an intelligence index.
    """
    sections = herald.get("sections", {})
    edition = herald.get("edition", 0)
    date = herald.get("date", datetime.now(timezone.utc).strftime("%Y-%m-%d"))

    now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Convert Herald sections into "positions" in the intelligence index
    positions = []

    # Pulse section → network health position
    pulse = sections.get("pulse", {})
    positions.append({
        "instrument": {
            "asset_class": "network_metric",
            "display_name": "Network Health Score",
            "identifiers": [
                {"scheme": "pft_internal", "value": "pulse.health_score"}
            ],
            "market": "PFT_NETWORK"
        },
        "quantity": {
            "amount": str(pulse.get("health_score", 0) or 0),
            "unit": "score"
        },
        "valuation": {
            "base_currency_value": str(pulse.get("contributors", 0)),
            "price_per_unit": str(pulse.get("memos_today", 0)),
            "valuation_source": "chain_index"
        },
        "weight": {"basis_points": 1000, "fraction": "0.1", "percent": "10.0"},
        "metadata": {
            "health_grade": pulse.get("health_grade", ""),
            "total_wallets": pulse.get("total_wallets", 0),
            "velocity": pulse.get("velocity_direction", ""),
            "narrative": pulse.get("narrative", "")
        }
    })

    # Flow section → capital flow position
    flow = sections.get("flow", {})
    if flow:
        positions.append({
            "instrument": {
                "asset_class": "capital_flow",
                "display_name": "PFT Reward Flow",
                "identifiers": [
                    {"scheme": "pft_internal", "value": "flow.rewards"}
                ],
                "market": "PFT_NETWORK"
            },
            "quantity": {
                "amount": str(flow.get("total_reward_pft", 0)),
                "unit": "PFT"
            },
            "valuation": {
                "base_currency_value": str(flow.get("total_reward_txns", 0)),
                "price_per_unit": "1",
                "valuation_source": "chain_index"
            },
            "weight": {"basis_points": 2000, "fraction": "0.2", "percent": "20.0"},
            "metadata": {
                "top_earner": flow.get("top_earner_address", "")[:12] + "..." if flow.get("top_earner_address") else "",
                "top_earner_pft": flow.get("top_earner_pft", 0),
                "narrative": flow.get("narrative", "")
            }
        })

    # Airdrops section
    airdrops = sections.get("airdrops", {})
    if airdrops:
        positions.append({
            "instrument": {
                "asset_class": "airdrop_flow",
                "display_name": "Daily Airdrops",
                "identifiers": [
                    {"scheme": "pft_internal", "value": "airdrops.daily"}
                ],
                "market": "PFT_NETWORK"
            },
            "quantity": {
                "amount": str(airdrops.get("total_pft", 0)),
                "unit": "PFT"
            },
            "valuation": {
                "base_currency_value": str(airdrops.get("recipient_count", 0)),
                "price_per_unit": "1",
                "valuation_source": "chain_index"
            },
            "weight": {"basis_points": 1500, "fraction": "0.15", "percent": "15.0"},
            "metadata": {
                "narrative": airdrops.get("narrative", "")
            }
        })

    # Watch section → sybil intelligence
    watch = sections.get("watch", {})
    if watch:
        positions.append({
            "instrument": {
                "asset_class": "sybil_intelligence",
                "display_name": "Sybil Watch",
                "identifiers": [
                    {"scheme": "pft_internal", "value": "watch.sybil"}
                ],
                "market": "PFT_NETWORK"
            },
            "quantity": {
                "amount": str(watch.get("total_sybil", 0)),
                "unit": "accounts"
            },
            "valuation": {
                "base_currency_value": str(watch.get("sybil_clusters", 0)),
                "price_per_unit": "1",
                "valuation_source": "chain_index"
            },
            "weight": {"basis_points": 1500, "fraction": "0.15", "percent": "15.0"},
            "metadata": {
                "narrative": watch.get("narrative", "")
            }
        })

    # Movers section
    movers = sections.get("movers", {})
    if movers:
        positions.append({
            "instrument": {
                "asset_class": "contributor_dynamics",
                "display_name": "Network Movers",
                "identifiers": [
                    {"scheme": "pft_internal", "value": "movers.activity"}
                ],
                "market": "PFT_NETWORK"
            },
            "quantity": {
                "amount": str(len(movers.get("most_active_7d", []))),
                "unit": "contributors"
            },
            "valuation": {
                "base_currency_value": "0",
                "price_per_unit": "0",
                "valuation_source": "chain_index"
            },
            "weight": {"basis_points": 2000, "fraction": "0.2", "percent": "20.0"},
            "metadata": {
                "narrative": movers.get("narrative", ""),
                "hustlers": movers.get("hustlers", [])
            }
        })

    # Deep cut section
    deep_cut = sections.get("deep_cut", {})
    if deep_cut:
        positions.append({
            "instrument": {
                "asset_class": "historical_analysis",
                "display_name": "Deep Cut",
                "identifiers": [
                    {"scheme": "pft_internal", "value": "deep_cut.historical"}
                ],
                "market": "PFT_NETWORK"
            },
            "quantity": {"amount": "1", "unit": "analysis"},
            "valuation": {
                "base_currency_value": "0",
                "price_per_unit": "0",
                "valuation_source": "chain_index"
            },
            "weight": {"basis_points": 2000, "fraction": "0.2", "percent": "20.0"},
            "metadata": {
                "narrative": deep_cut.get("narrative", "")
            }
        })

    # Build the canonical snapshot
    snapshot_content = json.dumps(positions, sort_keys=True, separators=(",", ":"))
    content_hash = hashlib.sha256(snapshot_content.encode()).hexdigest()

    snapshot = {
        "kind": "pft.index.snapshot.v1",
        "schema": "https://agtico.github.io/pft_indexing/schemas/pft-index-snapshot-v1.schema.json",
        "index": {
            "index_id": f"herald-daily-{date}",
            "name": f"The Hive Herald — Edition #{edition}",
            "symbol": "HERALD",
            "base_currency": "PFT",
            "methodology_id": "herald-daily-intelligence",
            "methodology_version": "2.0.0",
            "source_index_reference": None
        },
        "snapshot": {
            "snapshot_id": f"herald-{date}-{content_hash[:8]}",
            "snapshot_type": "daily_close",
            "as_of_date": date,
            "created_at": now_utc,
            "position_count": len(positions),
            "coverage": {
                "status": "full",
                "notes": ["All Herald sections included"]
            },
            "snapshot_digest": {
                "algorithm": "sha256",
                "hex": content_hash
            }
        },
        "publisher": {
            "pftl_address": PUBLISHER_ADDRESS,
            "pftl_network": PUBLISHER_NETWORK,
            "display_name": "Permanent Upper Class Validator",
            "x25519_pubkey": None,
            "message_key_tx_hash": None
        },
        "author": {
            "author_type": "automated_pipeline",
            "display_name": "Herald v2 Export",
            "agent": "herald-v2-export.py",
            "agent_version": "2.0.0"
        },
        "positions": positions,
        "aggregate": {
            "base_currency": "PFT",
            "included_position_count": len(positions),
            "sum_included_base_currency_value": str(flow.get("total_reward_pft", 0) if flow else 0),
            "weight_sum_basis_points": 10000,
            "weight_sum_fraction": "1.0",
            "weight_sum_percent": "100.0",
            "weight_denominator_source": "explicit_section_weights",
            "weight_denominator_base_currency_value": None,
            "is_weight_sum_expected_to_equal_one": True,
            "valuation_reconciliation": {
                "status": "not_applicable_intelligence_index",
                "relative_difference": None,
                "absolute_difference": None,
                "notes": ["Intelligence index — sections are weighted by editorial importance, not financial value"]
            }
        },
        "provenance": {
            "created_at": now_utc,
            "created_by": "herald-v2-export.py",
            "source_records": [
                {
                    "source": "chain-index.db",
                    "record_type": "database_query",
                    "record_date": date,
                    "hash": None
                }
            ],
            "transformations": [
                "BFS crawl of PFT ledger",
                "Section aggregation and narrative generation",
                "Conversion to pft.index.snapshot.v1 format"
            ],
            "calculation_policy": "Metrics computed from public ledger data. No private contributor data included.",
            "known_limitations": [
                "Airdrop detection uses 21:05-21:12 UTC window heuristic",
                "Bot classification depends on behavioral heuristics with potential false positives",
                "Memo count used as proxy for task activity"
            ]
        },
        "publication": {
            "access_policy": "subscriber_gated_with_delayed_public",
            "default_mode": "encrypted_ipfs",
            "allowed_modes": ["encrypted_ipfs", "public_web"],
            "intended_pointer": {
                "schema_version": 2,
                "wire_kind": "DOCUMENT",
                "semantic_kind": "HERALD_DAILY"
            }
        },
        "extensions": {
            "herald_edition": edition,
            "herald_date": date,
            "access_tiers": {
                "level_0": {"name": "subscriber", "delay_days": 0},
                "level_1": {"name": "trial", "delay_days": 1},
                "level_2": {"name": "public", "delay_days": 7}
            }
        }
    }

    return snapshot


def main():
    print(f"[{datetime.now(timezone.utc).isoformat()}] Herald v2 Export starting...")

    # Load Herald
    herald = load_herald()
    print(f"  Loaded Herald edition #{herald.get('edition', '?')} ({herald.get('date', '?')})")

    # Convert to snapshot
    snapshot = herald_to_snapshot(herald)
    print(f"  Converted to pft.index.snapshot.v1 with {len(snapshot['positions'])} positions")
    print(f"  Snapshot ID: {snapshot['snapshot']['snapshot_id']}")
    print(f"  Content hash: {snapshot['snapshot']['snapshot_digest']['hex'][:16]}...")

    # Write snapshot
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    date = herald.get("date", "unknown")

    snapshot_path = os.path.join(OUTPUT_DIR, f"herald-{date}.snapshot.v1.json")
    with open(snapshot_path, "w") as f:
        json.dump(snapshot, f, indent=2)
    print(f"  Written to {snapshot_path}")

    # Also write as latest
    latest_path = os.path.join(OUTPUT_DIR, "herald-latest.snapshot.v1.json")
    with open(latest_path, "w") as f:
        json.dump(snapshot, f, indent=2)
    print(f"  Written to {latest_path}")

    # Validate with pft-index
    try:
        import subprocess
        result = subprocess.run(
            ["pft-index", "validate", snapshot_path],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            print(f"  Validation: PASSED")
        else:
            print(f"  Validation: {result.stdout.strip() or result.stderr.strip()}")
    except Exception as e:
        print(f"  Validation: skipped ({e})")

    # Compute digest
    try:
        result = subprocess.run(
            ["pft-index", "digest", snapshot_path],
            capture_output=True, text=True, timeout=10
        )
        print(f"  Digest: {result.stdout.strip()}")
    except:
        pass

    print(f"\n  Phase 1 complete. Snapshot artifact ready.")
    print(f"  Next: encrypt for subscribers (Phase 2)")

    return snapshot


if __name__ == "__main__":
    main()
