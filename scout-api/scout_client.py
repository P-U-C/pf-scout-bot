"""Wrapper around pf-scout CLI and Python API."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Optional

from .models import ContactProfile, ContactSummary

SCOUT_DB = os.environ.get("PF_SCOUT_DB", str(Path.home() / ".pf-scout" / "contacts.db"))


def _run(cmd: list[str], timeout: int = 30) -> Optional[str]:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    except Exception:
        pass
    return None


def get_contact_count() -> int:
    out = _run(["pf-scout", "list", "--format", "json"], timeout=10)
    if out:
        try:
            data = json.loads(out)
            return len(data) if isinstance(data, list) else 0
        except json.JSONDecodeError:
            pass
    return -1


def search_contacts(
    query: str,
    limit: int = 10,
    tier: Optional[str] = None,
    tags: Optional[list[str]] = None,
    rubric: Optional[str] = None,
    min_score: Optional[float] = None,
) -> list[ContactSummary]:
    cmd = ["pf-scout", "list", "--format", "json", "--limit", str(limit)]
    if tier:
        cmd += ["--tier", tier]
    if rubric:
        cmd += ["--rubric", f"rubrics/{rubric}.yaml"]

    out = _run(cmd)
    contacts: list[dict] = []
    if out:
        try:
            contacts = json.loads(out)
        except json.JSONDecodeError:
            contacts = []

    if query and contacts:
        q = query.lower()
        contacts = [c for c in contacts if q in json.dumps(c).lower()]

    if min_score is not None:
        contacts = [c for c in contacts if (c.get("score") or 0) >= min_score]

    if tags:
        contacts = [
            c for c in contacts
            if any(t in (c.get("tags") or []) for t in tags)
        ]

    return [_to_summary(c) for c in contacts[:limit]]


def get_profile(identifier: str, rubric: Optional[str] = None) -> Optional[ContactProfile]:
    cmd = ["pf-scout", "show", identifier, "--format", "json"]
    if rubric:
        cmd += ["--rubric", f"rubrics/{rubric}.yaml"]

    out = _run(cmd)
    if not out:
        return None
    try:
        data = json.loads(out)
        return _to_profile(data) if isinstance(data, dict) else None
    except json.JSONDecodeError:
        return None


def _to_summary(data: dict) -> ContactSummary:
    return ContactSummary(
        identifier=data.get("identifier", ""),
        display_name=data.get("name") or data.get("display_name"),
        tier=data.get("tier"),
        score=data.get("score"),
        tags=data.get("tags") or [],
        sources=data.get("sources") or [],
        last_updated=data.get("updated_at"),
        bio=data.get("bio"),
    )


def _to_profile(data: dict) -> ContactProfile:
    return ContactProfile(
        identifier=data.get("identifier", ""),
        display_name=data.get("name") or data.get("display_name"),
        all_identifiers=data.get("identifiers") or [],
        tier=data.get("tier"),
        score=data.get("score"),
        rubric_used=data.get("rubric"),
        tags=data.get("tags") or [],
        sources=data.get("sources") or [],
        notes=data.get("notes") or [],
        bio=data.get("bio"),
        location=data.get("location"),
        skills=data.get("skills") or [],
        github_stats=data.get("github"),
        postfiat_stats=data.get("postfiat"),
        last_updated=data.get("updated_at"),
        snapshot_history=data.get("snapshots") or [],
    )
