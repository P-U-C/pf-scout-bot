# Changelog

All notable changes to pf-scout-bot are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

---

## [0.1.0] — 2026-03-18

### Added

**Phase 1 — Scout API**
- FastAPI HTTP server over pf-scout contacts.db (port 8420)
- `GET /health` — DB status and contact count
- `POST /search` — natural language + structured filter search
- `GET /profile/{identifier}` — full contact profile with score history and related contacts
- `GET /list` — filtered, ranked contact list
- `source=external/internal` filter on search
- Pydantic v2 request/response models
- Dockerfile + systemd service unit

**Phase 2 — Autonomous Bot**
- TypeScript XRPL polling bot (60s interval)
- XRPL `account_tx` scan for inbound memo messages
- Natural language query parser (no LLM needed for routing)
- Scout-api HTTP client with 10s timeout
- LLM response formatter: Anthropic → OpenAI → template fallback (≤400 chars on-chain)
- SIGINT/SIGTERM graceful shutdown
- Per-message error recovery (one failed message doesn't stop the loop)

**Phase 3 — Enrichment Pipeline**
- `enrichment/leaderboard.py` — PF leaderboard sync; content-addressed dedup (only writes on score change)
- `enrichment/relationships.py` — GitHub co-contributor graph; relationship notes surfaced in `/profile`
- `enrichment/external_prospects.py` — scouts configured GitHub orgs for external talent; tagged `external-prospect`
- `enrichment/refresh.py` — orchestrator (`python3 -m enrichment.refresh`)
- systemd timer (every 6h, persistent)
- `related_contacts[]` field on ContactProfile responses

**CI/CD**
- GitHub Actions CI: Python ruff lint + syntax check + FastAPI import; TypeScript `tsc --noEmit`
- GitHub Actions Release: tag-triggered, changelog from git log, tarball + sha256 artifacts

[0.1.0]: https://github.com/P-U-C/pf-scout-bot/releases/tag/v0.1.0
