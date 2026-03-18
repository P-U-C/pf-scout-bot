"""Authorization tier enforcement for the scout-api.

Checks the contributor_authorization table (from the b1e55ed Auth Gate)
and returns a visibility tier used to filter API responses.

Falls back to UNKNOWN if:
  - No requester_wallet provided
  - DB not accessible
  - Wallet not found in contributor_authorization
"""
from __future__ import annotations

import sqlite3
from enum import Enum
from pathlib import Path


class VisibilityTier(str, Enum):
    """Maps contributor_authorization.state to API visibility level."""
    TRUSTED = "TRUSTED"          # full profile + signal history
    AUTHORIZED = "AUTHORIZED"    # + notes + relationships
    UNKNOWN = "UNKNOWN"          # public fields only (scores, tags, bio)
    COOLDOWN = "COOLDOWN"        # same as UNKNOWN (degraded, no mention)
    SUSPENDED = "SUSPENDED"      # own profile only — handled at route layer


# Fields stripped for UNKNOWN and COOLDOWN callers
_RESTRICTED_FIELDS = frozenset(["notes", "related_contacts", "snapshot_history"])

# State → tier mapping
_STATE_TO_TIER: dict[str, VisibilityTier] = {
    "TRUSTED": VisibilityTier.TRUSTED,
    "AUTHORIZED": VisibilityTier.AUTHORIZED,
    "UNKNOWN": VisibilityTier.UNKNOWN,
    "COOLDOWN": VisibilityTier.COOLDOWN,
    "SUSPENDED": VisibilityTier.SUSPENDED,
}


def _find_auth_db() -> Path | None:
    """Try to find the b1e55ed brain.db that holds contributor_authorization."""
    candidates = [
        Path.home() / ".b1e55ed" / "data" / "brain.db",
        Path("/data/brain.db"),
    ]
    for p in candidates:
        if p.exists():
            return p
    return None


def get_visibility_tier(requester_wallet: str | None) -> VisibilityTier:
    """Return the visibility tier for the given wallet address.

    Returns UNKNOWN on any error or missing wallet.
    Never raises — safe to call from any route.
    """
    if not requester_wallet:
        return VisibilityTier.UNKNOWN

    db_path = _find_auth_db()
    if not db_path:
        return VisibilityTier.UNKNOWN

    try:
        conn = sqlite3.connect(db_path)
        row = conn.execute(
            "SELECT state FROM contributor_authorization WHERE wallet = ?",
            (requester_wallet,),
        ).fetchone()
        conn.close()
        if not row:
            return VisibilityTier.UNKNOWN
        return _STATE_TO_TIER.get(str(row[0]).upper(), VisibilityTier.UNKNOWN)
    except Exception:
        return VisibilityTier.UNKNOWN


def apply_visibility_filter(data: dict, tier: VisibilityTier) -> dict:
    """Strip fields from a profile dict based on the caller's visibility tier.

    TRUSTED   — no filtering
    AUTHORIZED — no filtering
    UNKNOWN/COOLDOWN — strip notes, related_contacts, snapshot_history
    SUSPENDED — should be blocked at route layer before reaching here
    """
    if tier in (VisibilityTier.TRUSTED, VisibilityTier.AUTHORIZED):
        return data
    # UNKNOWN and COOLDOWN: strip restricted fields
    return {k: ([] if k in _RESTRICTED_FIELDS else v) for k, v in data.items()}
