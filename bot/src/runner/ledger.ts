/**
 * runner/ledger.ts — append-only JSONL audit ledger.
 *
 * Every decision the runner makes is recorded here, whether or not it resulted
 * in an on-chain action. This is the accountability spine: in DRY_RUN and
 * readonly modes it is the ONLY output, and in auto mode it is the record that
 * lets a human reconstruct exactly what the agent did and why.
 *
 * Never write seeds, private keys, or full decrypted deliverable bodies here —
 * only hashes/summaries.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export type LedgerEvent =
  | "scan"        // saw an inbound message
  | "consider"    // classified it as a task offer
  | "refuse"      // policy declined
  | "defer"       // policy deferred (cap/cadence/manual queue)
  | "accept"      // accepted the task
  | "execute"     // produced a deliverable
  | "submit"      // submitted on-chain (or simulated)
  | "error"       // something failed
  | "killed";     // kill switch tripped

export interface LedgerRecord {
  ts: string;             // ISO timestamp (caller-supplied; loop stamps it)
  profile: string;        // A | B
  account: string;        // r-address (public, fine to log)
  event: LedgerEvent;
  taskId?: string;
  sender?: string;
  rewardPft?: number;
  decision?: string;      // human-readable outcome
  reason?: string;        // why
  txHash?: string;        // when an on-chain action occurred
  dryRun: boolean;
  approvalMode: string;
}

export class Ledger {
  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(rec: LedgerRecord): void {
    appendFileSync(this.path, JSON.stringify(rec) + "\n");
  }

  /** Count accept events for a given UTC day (YYYY-MM-DD). Used by the day-cap. */
  acceptsOnUtcDay(day: string): number {
    if (!existsSync(this.path)) return 0;
    let n = 0;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as LedgerRecord;
        if (r.event === "accept" && r.ts.startsWith(day)) n++;
      } catch { /* skip malformed */ }
    }
    return n;
  }

  /** ISO timestamp of the most recent accept, or null. Used by the cadence floor. */
  lastAcceptTs(): string | null {
    if (!existsSync(this.path)) return null;
    let last: string | null = null;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as LedgerRecord;
        if (r.event === "accept") last = r.ts;
      } catch { /* skip */ }
    }
    return last;
  }

  /** Has this task already been handled (accepted/submitted)? Dedup guard. */
  alreadyHandled(taskId: string): boolean {
    if (!taskId || !existsSync(this.path)) return false;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as LedgerRecord;
        if (r.taskId === taskId && (r.event === "accept" || r.event === "submit")) return true;
      } catch { /* skip */ }
    }
    return false;
  }
}
