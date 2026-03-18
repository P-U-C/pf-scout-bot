# PF Scout Bot — Phase 2: Autonomous XRPL Polling Bot

TypeScript bot that runs headless on a server, continuously polls the XRPL for inbound messages addressed to the bot's wallet, processes scout queries via `pf-scout-api`, and sends concise on-chain replies.

---

## Architecture

```
XRPL chain  ←→  bot/src/chain.ts  (scan + send)
                      │
                 router.ts         (parse NL → ScoutQuery)
                      │
                 scout-client.ts   (HTTP → pf-scout-api :8420)
                      │
                 responder.ts      (LLM or template → ≤400 char reply)
```

---

## Prerequisites

- Node.js ≥ 18
- A funded XRPL wallet (BOT_SEED) — see below
- pf-scout-api running on port 8420 (Phase 1)

---

## Getting a BOT_SEED

Option A — generate with xrpl-keygen:
```bash
npx xrpl-keygen
# Save the seed (starts with 's') — fund the address with ≥5 XRP
```

Option B — use pft-chatbot-mcp wallet generation:
```bash
pft-chatbot-mcp wallet create
# Follow prompts, copy the seed
```

The bot wallet needs:
- At least 2 XRP (reserve) + enough for outbound transactions
- Registered in the Post Fiat Task Node Agent Directory to appear with a live heartbeat dot

---

## Activating in the Agent Directory

1. Fund wallet with ≥ 10 PFT
2. Submit a `TaskNode:agent:register` transaction with your bot's metadata
3. The bot will appear in the Agent Directory with:
   - Name: `PF Scout`
   - Description: `Contributor discovery and recruitment intelligence for the Post Fiat ecosystem`
   - Status: online (while bot is running)

See [pft-chatbot-mcp docs](https://github.com/postfiatorg/pft-chatbot-mcp) for full registration flow.

---

## Configuration

Copy `deploy/.env.example` and edit:

```bash
cp ../deploy/.env.example ../.env
$EDITOR ../.env
```

Required vars:
| Variable | Description |
|---|---|
| `BOT_SEED` | XRPL wallet seed (starts with `sEd`) |
| `XRPL_SERVER` | WebSocket RPC URL (default: `wss://xrplcluster.com`) |
| `SCOUT_API_URL` | pf-scout-api base URL (default: `http://127.0.0.1:8420`) |

Optional (for LLM-formatted responses):
| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key (preferred) |
| `OPENAI_API_KEY` | OpenAI API key (fallback) |
| `LLM_MODEL` | Model name (default: `claude-3-haiku-20240307`) |

---

## Running

```bash
# Install deps
cd bot && npm install

# Development (hot reload)
npm run dev

# Production
npm start

# Or build and run compiled JS
npm run build
node dist/index.js
```

---

## Example conversation

User sends to bot address on XRPL:
```
find me a TypeScript developer active in the last 60 days
```

Bot responds on-chain (≤400 chars):
```
Top match: alex_dev [tier1] (score: 87)
Skills: TypeScript, Solana, XRPL smart contracts
Active: 3 PF tasks completed this month, 12 GitHub commits
Why: Strong cross-chain background, recent XRPL hook work.
Reply with their handle for full profile.
```

---

## Message Protocol

### Inbound (v0 — plain text)
The bot reads `Payment` transactions sent **to** its address that carry a `Memo` with `MemoType: text/plain`.

### Outbound
The bot sends a `Payment` of 0.001 XRP back to the sender with the response in the memo field.

### Encrypted (v1 — future)
Keystone envelope encryption via `pft-chatbot-mcp` libsodium wrappers — swap the `chain.ts` decode step when ready.

---

## Systemd deployment

See `deploy/pf-scout-bot.service` and `deploy/install.sh`.

Quick start:
```bash
sudo bash deploy/install.sh
sudo systemctl start pf-scout-api pf-scout-bot
sudo journalctl -fu pf-scout-bot
```
