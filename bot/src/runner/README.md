# PFTL Task-Runner

An autonomous Task Node contributor: scans inbound task offers, decides
accept/refuse, produces a deliverable, and submits it for reward — built on the
scout bot's chain primitives (`chain.ts`: `scanInbound` read+decrypt, `sendReply`
sign+write).

## Safety model (three independent guards, all default-safe)

| Guard | Env | Default | Effect |
|---|---|---|---|
| Approval mode | `APPROVAL_MODE` | `readonly` | `readonly` scans+logs only; `manual` queues accepts for human approval; `auto` signs |
| Dry run | `DRY_RUN` | `true` | when true, execute/submit are simulated — **no on-chain write ever** |
| Kill switch | `RUNNER_KILL` / file | off | `touch ~/.pftl-runner-STOP` (or `RUNNER_KILL=1`) hard-stops at the next iteration and before any write |

On-chain signing happens **only** when `APPROVAL_MODE=auto` AND `DRY_RUN=false` AND no kill switch AND the day-cap/cadence guards pass.

## Pacing / integrity guards (anti-extraction-fingerprint)

Deliberately shaped like the reward-integrity anomaly rules we proposed for Lens
(per-account day-cap + velocity floor) so the disciplined account never reproduces
the machine-paced extraction pattern we flagged on-chain (e.g. gmoney: 265
rewards/day @ ~1/5min).

| Profile | day-cap | min gap | jitter | reward floor | quality floor |
|---|---|---|---|---|---|
| **A** (expendable / aggressive) | 40 | 90s | 120s | 0 | 0.30 |
| **B** (disciplined / the product) | 8 | 1800s | 1200s | 1 PFT | 0.70 |

Quality floor: the executor self-scores each deliverable; below the floor it
**abstains** rather than submitting low-effort work.

## Phased go-live

0. **readonly + dry-run** (now): `APPROVAL_MODE=readonly` — proves scan/decrypt/classify/ledger against a live account, signs nothing.
1. **manual**: `APPROVAL_MODE=manual` — accepts are queued to the ledger; a human approves before signing.
2. **auto + dry-run**: full loop, submissions simulated — verifies executor + day-cap/cadence end-to-end.
3. **auto + live**: `APPROVAL_MODE=auto DRY_RUN=false` — **only after the accept/submit seam is verified** (see below).

## A/B test (blocked on provisioning)

Two disconnected accounts: **A** expendable/aggressive (test the ceiling), **B**
disciplined/quality (the real product). To arm, each account needs:

1. `BOT_SEED` — account seed (signing). Set in 600-perm env; never logged/committed.
2. Keystone recipient shard provisioned for the account (so `scanInbound` can decrypt inbound task offers — without it the loop sees nothing).
3. Funding (XRP reserve + any task-accept fee).
4. `KEYSTONE_GRPC_URL` / `KEYSTONE_API_KEY` for outbound encryption.

## Integration seam (must verify before step 3)

`accept` and `submit` are currently modelled as outbound keystone messages via
`sendReply`. The Task Node's exact accept/submit memo types must be confirmed
against a live account in the A/B test; `loop.ts:signAction` is the single place
to wire the real protocol calls. **Do not set `DRY_RUN=false` until this is
verified.**

## Run

```bash
# offline harness proof (no account needed)
npx tsx src/runner/selftest.ts

# readonly against a provisioned account
APPROVAL_MODE=readonly BOT_SEED=... npx tsx src/runner/index.ts
```

Audit ledger (append-only JSONL): `~/.pftl-runner/ledger.jsonl`.
