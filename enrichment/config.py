"""Enrichment configuration — loaded from environment variables."""
from __future__ import annotations

import os
from pathlib import Path


class EnrichmentConfig:
    pf_scout_db: str = os.environ.get("PF_SCOUT_DB", str(Path.home() / ".pf-scout" / "contacts.db"))
    pf_jwt_token: str = os.environ.get("PF_JWT_TOKEN", "")
    pf_session_cookie: str = os.environ.get("PF_SESSION_COOKIE", "")
    github_token: str = os.environ.get("GITHUB_TOKEN", "")
    pf_leaderboard_url: str = os.environ.get("PF_LEADERBOARD_URL", "https://tasknode.postfiat.org")
    refresh_interval_hours: int = int(os.environ.get("REFRESH_INTERVAL_HOURS", "6"))
    external_orgs: list[str] = os.environ.get(
        "EXTERNAL_SCOUT_ORGS",
        "cosmos,ethereum,solana-labs,ripple,hyperledger",
    ).split(",")
    max_external_per_org: int = int(os.environ.get("MAX_EXTERNAL_PER_ORG", "20"))
    rubric: str = os.environ.get("SCOUT_RUBRIC", "b1e55ed")


config = EnrichmentConfig()
