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

### Phase 2 — Autonomous XRPL Polling Bot ✅

Headless TypeScript bot (`bot/`) that polls the XRPL every 60 s for inbound messages.

- Scans bot wallet with `account_tx` for new memos
- Routes natural language queries to `pf-scout-api`
- Formats responses with an LLM (Claude/GPT) or template fallback (≤400 chars)
- Sends reply as a plain-text memo `Payment` back to the sender
- Systemd service included — runs as `pf-scout-bot`

### Phase 3 — Enrichment + External Scouting

Continuous signal refresh from GitHub, Post Fiat leaderboard, and Task Node on-chain activity. Relationship graph (who's worked with whom). External talent pipeline for contributors not yet in the ecosystem.

---

## Phase 2 — Running the Bot

### Quick start

```bash
cd bot
npm install

# Copy and fill in your env vars (BOT_SEED is required)
cp ../deploy/.env.example ../.env
$EDITOR ../.env

npm start
```

### Getting a BOT_SEED

```bash
# Option A — xrpl-keygen
npx xrpl-keygen
# Save the seed (starts with 's'), fund the address with ≥5 XRP

# Option B — pft-chatbot-mcp
pft-chatbot-mcp wallet create
```

The bot wallet needs ≥ 2 XRP reserve + small transaction budget (~0.001 XRP per reply).

### Registering in the Agent Directory

Once the bot is running you need to register it so it appears with a live dot in the Task Node Agent Directory:

1. Deposit ≥ 10 PFT into the bot wallet
2. Submit a `TaskNode:agent:register` memo transaction with your bot metadata
3. See [pft-chatbot-mcp docs](https://github.com/postfiatorg/pft-chatbot-mcp) for the full registration flow

### Example conversation

User sends a plain-text memo Payment to the bot's XRPL address:

```
find me a TypeScript developer active in the last 60 days
```

Bot responds on-chain (≤ 400 chars):

```
Top match: alex_dev [tier1] (score: 87)
Skills: TypeScript, Solana, XRPL smart contracts
Active: 3 PF tasks this month, 12 GitHub commits
Cross-chain background + recent XRPL hook work.
Reply with their handle for full profile.
```

### Bot commands

| Message | Action |
|---|---|
| `find <skill/role>` | Search contributors |
| `list [tier1\|tier2]` | Ranked list |
| `profile @handle` | Full profile |
| `help` | Usage guide |

---

## Phase 1 — Running the Scout API

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
