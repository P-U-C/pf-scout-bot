"""Relationship graph builder.

Analyzes existing signals to find co-contributor relationships between contacts.
Stores relationships as structured notes so the scout-api can surface them.

Relationship types (Phase 3):
  co_contributor:<org>  — both contacts have GitHub signals from the same org
  pf_peer               — future: same PF task/context signals

Phase 4 (future):
  chain_interaction     — wallet-to-wallet XRPL tx analysis
"""
from __future__ import annotations

import json
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone

from .config import config


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_relationship_graph(db_path: str | None = None) -> dict:
    """Analyze signals and write relationship notes. Returns summary."""
    db_path = db_path or config.pf_scout_db
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    # Build org → [contact_ids] from GitHub signals
    org_contributors: dict[str, list[str]] = defaultdict(list)
    rows = conn.execute(
        """SELECT s.contact_id, s.payload
           FROM signals s
           WHERE s.source = 'github'
             AND s.signal_type IN (
               'github/repo', 'github/commit', 'github/pr',
               'github/contribution', 'github/profile'
             )"""
    ).fetchall()

    for row in rows:
        try:
            payload = json.loads(row["payload"])
            repo = (
                payload.get("repo")
                or payload.get("repository")
                or payload.get("full_name")
                or payload.get("company")
                or ""
            )
            if repo:
                org = repo.split("/")[0] if "/" in repo else repo
                org = org.strip().lower()
                if org:
                    org_contributors[org].append(str(row["contact_id"]))
        except Exception:
            continue

    # Find co-contributor pairs
    relationships: list[tuple[str, str, str]] = []
    for org, contact_ids in org_contributors.items():
        unique_ids = list(dict.fromkeys(contact_ids))
        if len(unique_ids) < 2:
            continue
        for i, cid_a in enumerate(unique_ids):
            for cid_b in unique_ids[i + 1 :]:
                relationships.append((cid_a, cid_b, f"co_contributor:{org}"))

    # Write relationship notes (deduplicated by exact body match)
    added = 0
    now = _now()
    for cid_a, cid_b, rel_type in relationships:
        row_a = conn.execute(
            "SELECT canonical_label FROM contacts WHERE id=?", (cid_a,)
        ).fetchone()
        row_b = conn.execute(
            "SELECT canonical_label FROM contacts WHERE id=?", (cid_b,)
        ).fetchone()
        if not row_a or not row_b:
            continue

        label_a = row_a["canonical_label"]
        label_b = row_b["canonical_label"]

        for cid, note_body in [
            (cid_a, f"[relationship] {rel_type} with {label_b}"),
            (cid_b, f"[relationship] {rel_type} with {label_a}"),
        ]:
            exists = conn.execute(
                "SELECT 1 FROM notes WHERE contact_id=? AND body=?",
                (cid, note_body),
            ).fetchone()
            if not exists:
                conn.execute(
                    "INSERT INTO notes (contact_id, note_ts, author, body, privacy_tier)"
                    " VALUES (?,?,?,?,?)",
                    (cid, now, "pf-scout-bot/enrichment", note_body, "private"),
                )
                added += 1

    conn.commit()
    conn.close()
    return {"relationships_found": len(relationships), "notes_added": added}


def get_related_contacts(contact_id: str, db_path: str | None = None) -> list[dict]:
    """Return contacts related to *contact_id* via relationship notes."""
    db_path = db_path or config.pf_scout_db
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    notes = conn.execute(
        "SELECT body FROM notes WHERE contact_id=? AND body LIKE '[relationship]%'",
        (contact_id,),
    ).fetchall()

    related: list[dict] = []
    for note in notes:
        body: str = note["body"]
        # Format: "[relationship] co_contributor:org with DisplayName"
        inner = body.removeprefix("[relationship] ")
        parts = inner.split(" with ", 1)
        if len(parts) != 2:
            continue
        rel_type, other_label = parts
        other = conn.execute(
            "SELECT id, canonical_label FROM contacts WHERE canonical_label=?",
            (other_label,),
        ).fetchone()
        if other:
            related.append(
                {
                    "contact_id": str(other["id"]),
                    "label": other["canonical_label"],
                    "relationship": rel_type,
                }
            )

    conn.close()
    return related
