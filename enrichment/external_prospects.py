"""External prospect pipeline.

Scouts configured GitHub orgs for contributors not yet in the PF ecosystem.
New contacts are tagged 'external-prospect' and 'org:<orgname>'.

Requires GITHUB_TOKEN. Rate-limited to 10 profile enrichments per org.
"""
from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone

import httpx

from .config import config


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _is_known(conn: sqlite3.Connection, github_username: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM identifiers WHERE platform='github' AND identifier_value=?",
            (github_username,),
        ).fetchone()
        is not None
    )


def scout_external_org(org: str, max_results: int | None = None) -> dict:
    """Scout one GitHub org. Returns summary dict."""
    max_results = max_results or config.max_external_per_org

    if not config.github_token:
        return {"org": org, "skipped": True, "reason": "no GITHUB_TOKEN"}

    headers = {
        "Authorization": f"token {config.github_token}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "pf-scout-bot/0.1.0",
    }

    raw_members: list[dict] = []
    with httpx.Client(timeout=15, headers=headers) as client:
        try:
            resp = client.get(
                f"https://api.github.com/orgs/{org}/members",
                params={"per_page": max_results, "type": "all"},
            )
            if resp.status_code == 200:
                raw_members = resp.json()[:max_results]
        except Exception:
            pass

        # Enrich first 10 to stay within GitHub rate limits
        enriched: list[dict] = []
        for m in raw_members[:10]:
            uname = m.get("login", "")
            if not uname:
                continue
            entry: dict = {
                "github_username": uname,
                "avatar_url": m.get("avatar_url", ""),
                "profile_url": m.get("html_url", ""),
            }
            try:
                ur = client.get(f"https://api.github.com/users/{uname}")
                if ur.status_code == 200:
                    u = ur.json()
                    entry.update(
                        {
                            "display_name": u.get("name") or uname,
                            "bio": u.get("bio") or "",
                            "location": u.get("location") or "",
                            "public_repos": u.get("public_repos", 0),
                            "followers": u.get("followers", 0),
                            "company": u.get("company") or "",
                        }
                    )
            except Exception:
                pass
            enriched.append(entry)

    conn = sqlite3.connect(config.pf_scout_db)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")

    added = 0
    skipped = 0
    for c in enriched:
        uname = c.get("github_username", "")
        if not uname:
            continue
        if _is_known(conn, uname):
            skipped += 1
            continue

        contact_id = str(uuid.uuid4())
        identifier_id = str(uuid.uuid4())
        now = _now()
        display = c.get("display_name") or uname

        conn.execute(
            "INSERT INTO contacts (id, canonical_label, first_seen, last_updated, tags)"
            " VALUES (?,?,?,?,?)",
            (
                contact_id,
                display,
                now,
                now,
                json.dumps(["external-prospect", f"org:{org}"]),
            ),
        )
        conn.execute(
            """INSERT INTO identifiers
               (id, contact_id, platform, identifier_value, is_primary, first_seen, last_seen)
               VALUES (?,?,?,?,1,?,?)""",
            (identifier_id, contact_id, "github", uname, now, now),
        )
        conn.execute(
            """INSERT INTO signals
               (contact_id, identifier_id, collected_at, signal_ts, source, signal_type,
                source_event_id, event_fingerprint, payload, evidence_note)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (
                contact_id,
                identifier_id,
                now,
                now,
                "github",
                "github/profile",
                f"gh:profile:{uname}",
                f"gh:profile:{uname}:initial",
                json.dumps({k: v for k, v in c.items() if isinstance(v, (str, int, float))}),
                f"External prospect from {org}",
            ),
        )
        conn.commit()
        added += 1

    conn.close()
    return {"org": org, "added": added, "skipped_known": skipped, "total_found": len(enriched)}


def run_external_scouting() -> dict:
    """Scout all configured external orgs. Returns aggregate summary."""
    results = [scout_external_org(o.strip()) for o in config.external_orgs if o.strip()]
    total_added = sum(r.get("added", 0) for r in results)
    return {"orgs_scouted": len(results), "total_added": total_added, "details": results}
