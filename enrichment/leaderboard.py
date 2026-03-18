"""Post Fiat leaderboard ingestion.

Pulls the PF leaderboard and syncs all contributors into the pf-scout contacts DB.
Writes directly to SQLite — avoids the CLI overhead for bulk upserts.

Signal deduplication: event_fingerprint = sha256(f"leaderboard:{wallet}:{score}").
A new signal row is only created when the score changes.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import uuid
from datetime import datetime, timezone

import httpx

from .config import config


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _fingerprint(wallet: str, score: float) -> str:
    return hashlib.sha256(f"leaderboard:{wallet}:{score}".encode()).hexdigest()


def upsert_contact(conn: sqlite3.Connection, wallet: str, display_name: str) -> str:
    """Upsert a contact by postfiat wallet address. Returns contact_id."""
    row = conn.execute(
        "SELECT contact_id FROM identifiers WHERE platform=? AND identifier_value=?",
        ("postfiat", wallet),
    ).fetchone()
    if row:
        return str(row[0])

    contact_id = str(uuid.uuid4())
    identifier_id = str(uuid.uuid4())
    now = _now()
    label = display_name or wallet[:12]
    conn.execute(
        "INSERT INTO contacts (id, canonical_label, first_seen, last_updated) VALUES (?,?,?,?)",
        (contact_id, label, now, now),
    )
    conn.execute(
        """INSERT INTO identifiers
           (id, contact_id, platform, identifier_value, is_primary, first_seen, last_seen)
           VALUES (?,?,?,?,1,?,?)""",
        (identifier_id, contact_id, "postfiat", wallet, now, now),
    )
    conn.commit()
    return contact_id


def _get_identifier_id(conn: sqlite3.Connection, wallet: str) -> str | None:
    row = conn.execute(
        "SELECT id FROM identifiers WHERE platform='postfiat' AND identifier_value=?",
        (wallet,),
    ).fetchone()
    return str(row[0]) if row else None


def insert_leaderboard_signal(
    conn: sqlite3.Connection,
    contact_id: str,
    identifier_id: str,
    wallet: str,
    rank: int,
    score: float,
    pft_earned: float,
) -> bool:
    """Insert leaderboard signal. Returns True if new (score changed)."""
    fp = _fingerprint(wallet, score)
    now = _now()
    try:
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
                "postfiat",
                "postfiat/leaderboard",
                f"lb:{wallet}:{rank}",
                fp,
                json.dumps(
                    {"rank": rank, "score": score, "pft_earned": pft_earned, "wallet": wallet}
                ),
                f"Leaderboard rank #{rank}, score {score:.1f}",
            ),
        )
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False  # score unchanged


def sync_leaderboard() -> dict:
    """Fetch PF leaderboard and sync all contributors. Returns summary stats."""
    if not config.pf_session_cookie and not config.pf_jwt_token:
        return {"skipped": True, "reason": "no PF_SESSION_COOKIE or PF_JWT_TOKEN"}

    headers: dict[str, str] = {"User-Agent": "pf-scout-bot/0.1.0"}
    if config.pf_session_cookie:
        headers["Cookie"] = config.pf_session_cookie
    if config.pf_jwt_token:
        headers["Authorization"] = f"Bearer {config.pf_jwt_token}"

    contributors: list[dict] = []
    with httpx.Client(timeout=30, headers=headers) as client:
        for url in [
            f"{config.pf_leaderboard_url}/api/leaderboard",
            f"{config.pf_leaderboard_url}/leaderboard",
        ]:
            try:
                resp = client.get(url)
                if resp.status_code == 200:
                    contributors = _parse_leaderboard_response(resp)
                    if contributors:
                        break
            except Exception:
                continue

    if not contributors:
        return {"synced": 0, "new_signals": 0, "error": "could not fetch leaderboard"}

    conn = sqlite3.connect(config.pf_scout_db)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")

    synced = 0
    new_signals = 0
    for entry in contributors:
        wallet = entry.get("wallet", "")
        if not wallet:
            continue
        contact_id = upsert_contact(conn, wallet, entry.get("name", ""))
        iid = _get_identifier_id(conn, wallet)
        if iid:
            added = insert_leaderboard_signal(
                conn,
                contact_id,
                iid,
                wallet,
                entry.get("rank", 0),
                float(entry.get("score", 0.0)),
                float(entry.get("pft_earned", 0.0)),
            )
            if added:
                new_signals += 1
        synced += 1

    conn.close()
    return {"synced": synced, "new_signals": new_signals}


def _parse_leaderboard_response(resp: httpx.Response) -> list[dict]:
    try:
        data = resp.json()
        if isinstance(data, list):
            return data  # type: ignore[return-value]
        if isinstance(data, dict):
            for k in ("leaderboard", "contributors", "results", "data", "users"):
                if k in data and isinstance(data[k], list):
                    return data[k]  # type: ignore[return-value]
        return []
    except Exception:
        return _parse_leaderboard_html(resp.text)


def _parse_leaderboard_html(html: str) -> list[dict]:
    """Fallback: extract XRPL r-addresses from HTML."""
    wallets = re.findall(r"r[A-HJ-NP-Za-km-z1-9]{24,34}", html)
    return [
        {"wallet": w, "rank": i + 1, "score": 0.0, "pft_earned": 0.0}
        for i, w in enumerate(dict.fromkeys(wallets))  # dedupe, preserve order
    ]
