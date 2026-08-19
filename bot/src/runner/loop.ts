/**
 * runner/loop.ts — the task-runner main loop.
 *
 * Lifecycle per the Task Node semantics:
 *   request → (agent proposes) → ACCEPT → execute → SUBMIT → review → payment
 * The runner handles ACCEPT, execute, and SUBMIT. Each on-chain action is a
 * signed PFTL Payment carrying a keystone-encrypted envelope; we reuse the
 * scout bot's chain.ts primitives (scanInbound to read+decrypt, sendReply to
 * sign+write).
 *
 * INTEGRATION SEAM: accept/submit are modelled as outbound keystone messages
 * via sendReply. The Task Node's exact accept/submit memo types must be
 * confirmed against a live account in the A/B test; until then accept/submit
 * are clearly labelled and gated behind DRY_RUN. Do not flip DRY_RUN off until
 * the seam is verified against a provisioned account.
 */

import { initBotKeys, scanInbound, sendReply, type BotKeys, type ChainConfig } from "../chain.js";
import { loadRunnerConfig, type RunnerConfig } from "./config.js";
import { Ledger, type LedgerRecord } from "./ledger.js";
import { killReason } from "./killswitch.js";
import { decide, type TaskOffer } from "./policy.js";
import { execute } from "./executor.js";
import type { InboundMessage } from "../types.js";

function nowIso(): string {
  return new Date().toISOString();
}

/** Best-effort parse of a decrypted inbound message into a task offer. */
export function parseOffer(msg: InboundMessage): TaskOffer | null {
  const c = msg.content ?? "";
  const idMatch = c.match(/task_[0-9a-f]{16,}/i);
  if (!idMatch) return null; // not a task-bearing message
  let rewardPft = 0;
  const rewardMatch = c.match(/"?reward(?:_pft)?"?\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (rewardMatch) rewardPft = Number(rewardMatch[1]);
  let verification = "";
  const vMatch = c.match(/"?verification"?\s*[:=]\s*"?([A-Za-z ]+)"?/i);
  if (vMatch) verification = vMatch[1].trim();
  else if (/submit text/i.test(c)) verification = "Submit Text";
  return { taskId: idMatch[0], sender: msg.sender, rewardPft, brief: c, verification };
}

export class TaskRunner {
  private cfg: RunnerConfig;
  private keys!: BotKeys;
  private ledger: Ledger;
  private chainConfig: ChainConfig;
  private sinceLedger?: number;

  constructor(cfg = loadRunnerConfig()) {
    this.cfg = cfg;
    this.ledger = new Ledger(cfg.ledgerPath);
    this.chainConfig = { ...cfg.chain };
  }

  private log(rec: Omit<LedgerRecord, "ts" | "profile" | "dryRun" | "approvalMode" | "account">) {
    this.ledger.append({
      ts: nowIso(),
      profile: this.cfg.profile,
      account: this.keys?.address ?? "uninitialized",
      dryRun: this.cfg.dryRun,
      approvalMode: this.cfg.approvalMode,
      ...rec,
    });
  }

  async init(): Promise<void> {
    if (!this.cfg.botSeed) {
      throw new Error("BOT_SEED not set — runner needs a provisioned account to read/decrypt task offers");
    }
    this.keys = await initBotKeys(this.cfg.botSeed);
    console.error(
      `[runner] profile=${this.cfg.profile} account=${this.keys.address} ` +
      `mode=${this.cfg.approvalMode} dryRun=${this.cfg.dryRun} ` +
      `dayCap=${this.cfg.dayCap} minGap=${this.cfg.minGapSeconds}s`,
    );
  }

  /** One pass: scan, decide, and (per approvalMode) act. Returns #offers seen. */
  async tick(): Promise<number> {
    const kr = killReason(this.cfg.killSwitchFile);
    if (kr) {
      this.log({ event: "killed", reason: kr });
      throw new Error(`kill switch: ${kr}`);
    }

    const { messages, nextLedger } = await scanInbound(this.chainConfig, this.keys, this.sinceLedger);
    this.sinceLedger = nextLedger;

    let offers = 0;
    for (const msg of messages) {
      const offer = parseOffer(msg);
      if (!offer) continue;
      offers++;
      this.log({ event: "consider", taskId: offer.taskId, sender: offer.sender, rewardPft: offer.rewardPft });

      const d = decide(offer, this.cfg, this.ledger, nowIso());
      if (d.verdict !== "accept") {
        this.log({ event: d.verdict === "defer" ? "defer" : "refuse", taskId: offer.taskId, reason: d.reason });
        continue;
      }

      // ACCEPT path differs by approval mode.
      if (this.cfg.approvalMode === "readonly") {
        this.log({ event: "defer", taskId: offer.taskId, decision: "would-accept", reason: "readonly mode: no signing" });
        continue;
      }
      if (this.cfg.approvalMode === "manual") {
        this.log({ event: "defer", taskId: offer.taskId, decision: "queued", reason: "manual mode: awaiting human approval" });
        continue;
      }

      // approvalMode === "auto"
      await this.handleAccept(offer);
    }
    return offers;
  }

  /** auto-mode: accept → execute → submit, each guarded. */
  private async handleAccept(offer: TaskOffer): Promise<void> {
    const kr = killReason(this.cfg.killSwitchFile);
    if (kr) { this.log({ event: "killed", taskId: offer.taskId, reason: kr }); throw new Error(`kill switch: ${kr}`); }

    this.log({ event: "accept", taskId: offer.taskId, sender: offer.sender, rewardPft: offer.rewardPft, reason: "auto" });
    if (!this.cfg.dryRun) await this.signAction("accept", offer, "");

    const deliverable = await execute(offer, this.cfg);
    this.log({
      event: "execute", taskId: offer.taskId,
      decision: deliverable.abstained ? "abstained" : "produced",
      reason: `selfScore=${deliverable.selfScore.toFixed(2)} (floor ${this.cfg.qualityFloor})`,
    });
    if (deliverable.abstained) return; // quality gate: don't submit low-effort work

    if (this.cfg.dryRun) {
      this.log({ event: "submit", taskId: offer.taskId, decision: "simulated", reason: "DRY_RUN" });
      return;
    }
    const txHash = await this.signAction("submit", offer, deliverable.text);
    this.log({ event: "submit", taskId: offer.taskId, txHash, decision: "on-chain" });
  }

  /**
   * SEAM: sign an on-chain accept/submit. Uses sendReply (keystone Payment) as
   * transport; the precise accept/submit memo type must be verified live.
   */
  private async signAction(kind: "accept" | "submit", offer: TaskOffer, body: string): Promise<string> {
    const payload = JSON.stringify({ action: kind, taskId: offer.taskId, body });
    return await sendReply(this.chainConfig, this.keys, offer.sender, payload, this.cfg.botSeed);
  }
}
