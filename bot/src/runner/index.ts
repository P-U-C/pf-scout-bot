/**
 * runner/index.ts — entrypoint for the PFTL task-runner.
 *
 *   tsx src/runner/index.ts
 *
 * Defaults are SAFE: APPROVAL_MODE=readonly, DRY_RUN=true. To go live you must
 * explicitly set APPROVAL_MODE=auto, DRY_RUN=false, provide BOT_SEED for a
 * provisioned/funded account, and verify the accept/submit seam first.
 *
 * Stop anytime with:  touch ~/.pftl-runner-STOP   (or env RUNNER_KILL=1)
 */

import { TaskRunner } from "./loop.js";
import { loadRunnerConfig } from "./config.js";

async function main() {
  const cfg = loadRunnerConfig();
  const runner = new TaskRunner(cfg);
  await runner.init();

  // Loud guardrail banner when live signing is actually armed.
  if (cfg.approvalMode === "auto" && !cfg.dryRun) {
    console.error("[runner] *** LIVE SIGNING ARMED *** auto + DRY_RUN=false — on-chain actions will occur.");
  }

  let running = true;
  process.on("SIGINT", () => { running = false; });
  process.on("SIGTERM", () => { running = false; });

  while (running) {
    try {
      const seen = await runner.tick();
      if (seen) console.error(`[runner] tick: ${seen} task offer(s) processed`);
    } catch (e) {
      console.error(`[runner] halt: ${(e as Error).message}`);
      break; // kill switch / fatal — stop the loop
    }
    await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
  }
  console.error("[runner] stopped.");
}

main().catch((e) => { console.error(e); process.exit(1); });
