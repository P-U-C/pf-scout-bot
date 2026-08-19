/**
 * runner/killswitch.ts — hard stop, checked at the top of every loop iteration
 * and immediately before any on-chain write.
 *
 * Two independent triggers (either stops the runner):
 *   - env  RUNNER_KILL=1
 *   - a flag file existing on disk (default ~/.pftl-runner-STOP)
 *
 * The file trigger means an operator can stop an autonomous runner WITHOUT
 * access to its process/env — `touch ~/.pftl-runner-STOP` is enough.
 */

import { existsSync } from "node:fs";

export function killReason(killSwitchFile: string): string | null {
  if (process.env.RUNNER_KILL === "1" || process.env.RUNNER_KILL?.toLowerCase() === "true") {
    return "env RUNNER_KILL set";
  }
  if (existsSync(killSwitchFile)) {
    return `kill-switch file present: ${killSwitchFile}`;
  }
  return null;
}
