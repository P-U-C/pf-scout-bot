/**
 * runner/selftest.ts — offline harness proof. Exercises parseOffer + policy +
 * ledger (day-cap, cadence, dedup, reward floor, verification) WITHOUT any chain
 * access or provisioned account. Run:  tsx src/runner/selftest.ts
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "./ledger.js";
import { decide } from "./policy.js";
import { parseOffer } from "./loop.js";
import { loadRunnerConfig } from "./config.js";
import type { InboundMessage } from "../types.js";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

const dir = mkdtempSync(join(tmpdir(), "pftl-runner-"));
process.env.LEDGER_PATH = join(dir, "ledger.jsonl");
process.env.ACCOUNT_PROFILE = "B";
process.env.MIN_GAP_SECONDS = "1800";
process.env.DAY_CAP = "8";
const cfg = loadRunnerConfig();
const ledger = new Ledger(cfg.ledgerPath);

console.log("PFTL task-runner self-test (offline)\n");

// parseOffer
const msg: InboundMessage = {
  txHash: "abc", sender: "rSenderXXXXXXXXXXXXXXXXXXXXXXXXXX",
  content: 'New task task_bfb4ab3b1d26600c6afcc5561ad7f63c reward_pft: 1.5 verification: Submit Text. Describe a market insight.',
  ledgerIndex: 100, timestampIso: "2026-06-16T20:00:00Z", amountDrops: "0",
};
const offer = parseOffer(msg)!;
ok("parseOffer extracts task id", offer?.taskId === "task_bfb4ab3b1d26600c6afcc5561ad7f63c");
ok("parseOffer extracts reward", offer?.rewardPft === 1.5);
ok("parseOffer extracts verification", /text/i.test(offer?.verification ?? ""));
ok("non-task message returns null", parseOffer({ ...msg, content: "hello there" }) === null);

// reward floor (B: minRewardPft=1)
ok("accepts above reward floor", decide(offer, cfg, ledger, "2026-06-16T20:00:00Z").verdict === "accept");
ok("refuses below reward floor",
  decide({ ...offer, rewardPft: 0.5 }, cfg, ledger, "2026-06-16T20:00:00Z").verdict === "refuse");

// verification gate
ok("refuses unsupported verification",
  decide({ ...offer, verification: "Submit File" }, cfg, ledger, "2026-06-16T20:00:00Z").verdict === "refuse");

// thin brief
ok("refuses thin brief",
  decide({ ...offer, brief: "x" }, cfg, ledger, "2026-06-16T20:00:00Z").verdict === "refuse");

// cadence floor — accept one, then an immediate second should defer
ledger.append({ ts: "2026-06-16T20:00:00Z", profile: "B", account: "rX", event: "accept",
  taskId: offer.taskId, dryRun: true, approvalMode: "auto" });
ok("dedup refuses already-handled task",
  decide(offer, cfg, ledger, "2026-06-16T20:10:00Z").verdict === "refuse");
const o2 = { ...offer, taskId: "task_2222222222222222aaaa" };
ok("cadence floor defers too-soon second accept",
  decide(o2, cfg, ledger, "2026-06-16T20:05:00Z").verdict === "defer"); // 5min < 30min
ok("cadence floor clears after gap",
  decide(o2, cfg, ledger, "2026-06-16T20:40:00Z").verdict === "accept"); // 40min > 30min

// day-cap — simulate 8 accepts today
for (let i = 0; i < 8; i++) {
  ledger.append({ ts: `2026-06-17T0${i}:00:00Z`, profile: "B", account: "rX", event: "accept",
    taskId: `task_cap${i}00000000000000`, dryRun: true, approvalMode: "auto" });
}
ok("day-cap defers when reached",
  decide({ ...offer, taskId: "task_overflow0000000000" }, cfg, ledger, "2026-06-17T12:00:00Z").verdict === "defer");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
