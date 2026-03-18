# pf-scout-bot

Conversational scout bot for the Post Fiat Task Node — contributor discovery, recruitment, and networking via the PFTL chain agent interface.

Users find the bot in the Task Node Agent Directory and message it in natural language:

> "Find me TypeScript engineers active on Post Fiat in the last 60 days"
> "Who are the top contributors in the XRPL/DeFi space not yet in the ecosystem?"
> "What should I know about @username before I reach out?"

The bot responds on-chain with scored, reasoned answers — not a markdown dump.

---

## Architecture

```
Task Node UI (Agent Directory)
        │
        │  encrypted PFTL message
        ▼
pft-chatbot-mcp                ← chain I/O: scan, decrypt, respond
        │
        │  HTTP queries
        ▼
pf-scout-api  (port 8420)      ← intelligence layer (this repo, Phase 1)
        │
        ▼
pf-scout CLI + contacts.db     ← persistent contact profiles + scoring
        │
        ├── Internal signals    Post Fiat leaderboard, Task Node activity
        └── External signals    GitHub, social, org membership
```

---

## Build Phases

### Phase 1 — Scout API (current)

FastAPI HTTP server that makes the pf-scout contact database queryable by the bot.

Endpoints:
- `GET  /health`                    — DB status and contact count
- `POST /search`                    — natural language + filter search
- `GET  /profile/{identifier}`      — full contact profile with history
- `GET  /list?tier=top&rubric=...`  — filtered ranked list

### Phase 2 — Bot MCP Integration (next)

TypeScript layer that wires `pft-chatbot-mcp` to the scout API. Incoming PFTL messages trigger scout queries; LLM reasoning formats responses. Bot appears in the Task Node Agent Directory with a green heartbeat dot.

### Phase 3 — Enrichment + External Scouting

Continuous signal refresh from GitHub, Post Fiat leaderboard, and Task Node on-chain activity. Relationship graph (who's worked with whom). External talent pipeline for contributors not yet in the ecosystem.

---

## Running the Scout API

### Local development

```bash
cd scout-api
pip install -r requirements.txt

# Optional: set env vars
export PF_SCOUT_GITHUB_TOKEN=your-github-token
export PF_SCOUT_PF_JWT_TOKEN=your-postfiat-jwt

python -m uvicorn main:app --reload --port 8420
```

API docs available at `http://localhost:8420/docs`

### Example queries

```bash
# Health check
curl http://localhost:8420/health

# Search for TypeScript contributors
curl -X POST http://localhost:8420/search \
  -H "Content-Type: application/json" \
  -d '{"query": "typescript", "limit": 5}'

# Get a contact profile
curl http://localhost:8420/profile/github:allenday

# List top-tier contacts scored with a rubric
curl "http://localhost:8420/list?tier=top&rubric=b1e55ed&limit=10"
```

### Seeding contacts

```bash
# Seed from Post Fiat leaderboard
pf-scout seed postfiat --jwt $PF_JWT_TOKEN

# Seed from a GitHub org
pf-scout seed github --org postfiatorg --token $GITHUB_TOKEN

# Score all contacts against the b1e55ed rubric
pf-scout update --all --rubric rubrics/b1e55ed.yaml --auto
```

---

## Deployment

### Prerequisites

- Ubuntu 22.04+ VPS
- Python 3.11+
- `pf-scout` installed (`pip install pf-scout`)
- pf-scout workspace initialized (`pf-scout init`)

### Install

```bash
git clone https://github.com/P-U-C/pf-scout-bot /opt/pf-scout-bot
cp /opt/pf-scout-bot/deploy/.env.example /opt/pf-scout-bot/.env
# Edit .env with your tokens

cd /opt/pf-scout-bot/scout-api
pip install -r requirements.txt
```

### Systemd service

```bash
sudo cp /opt/pf-scout-bot/deploy/pf-scout-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable pf-scout-api
sudo systemctl start pf-scout-api
sudo journalctl -u pf-scout-api -f
```

---

## Related

- [pf-scout](https://github.com/P-U-C/pf-scout) — contact intelligence CLI
- [pft-chatbot-mcp](https://www.npmjs.com/package/@postfiatorg/pft-chatbot-mcp) — PFTL chain messaging MCP server
- [Post Fiat Task Node](https://tasknode.postfiat.org) — where the bot lives
