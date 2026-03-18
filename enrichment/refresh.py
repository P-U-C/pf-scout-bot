"""Enrichment refresh orchestrator.

Runs all enrichment jobs in sequence. Safe to call repeatedly — all jobs
are idempotent (dedup via fingerprints and exact-body note matching).

Usage:
  python3 -m enrichment.refresh           # one-shot, prints JSON summary
  python3 -m enrichment.refresh --quiet   # suppress JSON output
"""
from __future__ import annotations

import json
import logging
import sys
import time
from datetime import datetime, timezone

from .external_prospects import run_external_scouting
from .leaderboard import sync_leaderboard
from .relationships import build_relationship_graph

_log = logging.getLogger(__name__)


def run_full_refresh() -> dict:
    """Run all enrichment jobs. Returns summary dict."""
    start = time.time()
    results: dict = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "jobs": {},
    }

    _log.info("pf-scout enrichment: starting full refresh")

    for name, fn in [
        ("leaderboard", sync_leaderboard),
        ("relationships", build_relationship_graph),
        ("external_prospects", run_external_scouting),
    ]:
        try:
            r = fn()  # type: ignore[operator]
            results["jobs"][name] = r
            _log.info("%s: %s", name, r)
        except Exception as exc:
            results["jobs"][name] = {"error": str(exc)}
            _log.error("%s failed: %s", name, exc)

    results["duration_seconds"] = round(time.time() - start, 1)
    results["completed_at"] = datetime.now(timezone.utc).isoformat()
    _log.info(
        "pf-scout enrichment: complete in %.1fs", results["duration_seconds"]
    )
    return results


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    result = run_full_refresh()
    if "--quiet" not in sys.argv:
        print(json.dumps(result, indent=2))
