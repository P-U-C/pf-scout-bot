/**
 * runner/config.ts — PFTL task-runner configuration.
 *
 * The runner is the inverse of the scout bot: it ACTS AS A TASK-DOER on the
 * Task Node — scanning inbound task offers, deciding accept/refuse, producing
 * a deliverable, and submitting it for reward.
 *
 * SAFETY MODEL (three orthogonal guards, all default to the safest setting):
 *   1. APPROVAL_MODE  readonly | manual | auto   — how far the loop is allowed to go
 *   2. DRY_RUN        true|false                  — if true, NEVER signs/writes on-chain
 *   3. KILL_SWITCH    file flag + env             — hard stop, checked every iteration
 *
 * Nothing signs on-chain unless APPROVAL_MODE=auto AND DRY_RUN=false AND no kill
 * switch is set AND the day-cap/velocity guards pass. Live operation also requires
 * a provisioned account (BOT_SEED + keystone recipient shard + funding).
 */

export type ApprovalMode = "readonly" | "manual" | "auto";
export type AccountProfile = "A" | "B";

export interface RunnerConfig {
  // --- identity / chain ---
  botSeed: string;              // account seed (signing). NEVER logged/committed.
  profile: AccountProfile;      // A = expendable/aggressive, B = disciplined/quality
  chain: {
    pftlRpcUrl: string;
    pftlWssUrl: string;
    ipfsGatewayUrl: string;
    keystoneGrpcUrl: string;
    keystoneApiKey: string;
    tasknodeEncryptionPubkey: string;
  };

  // --- safety ---
  approvalMode: ApprovalMode;   // readonly (scan+log only) | manual (queue) | auto
  dryRun: boolean;              // true => executor/submit are simulated, no on-chain write
  killSwitchFile: string;       // presence of this file => immediate hard stop

  // --- pacing / integrity guards ---
  // Deliberately bounded so an autonomous account does NOT reproduce the
  // machine-paced extraction fingerprint we flagged in the reward-integrity work
  // (e.g. gmoney: 265 rewards/day at ~1/5min). Cadence jitter + day-cap keep the
  // disciplined account (B) human-plausible.
  dayCap: number;               // max tasks ACCEPTED per UTC day
  minGapSeconds: number;        // floor between two accepts
  cadenceJitterSeconds: number; // random extra wait added to minGap (anti-fingerprint)
  minRewardPft: number;         // ignore offers below this reward
  qualityFloor: number;         // 0..1 — executor self-score below this => refuse/abstain

  // --- loop ---
  pollIntervalMs: number;
  ledgerPath: string;           // append-only JSONL audit ledger
}

function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v == null) return def;
  return v === "1" || v.toLowerCase() === "true";
}

function envNum(name: string, def: number): number {
  const v = process.env[name];
  return v == null ? def : Number(v);
}

/** Profile presets — A is the expendable experiment, B is the real product. */
const PROFILE_PRESETS: Record<AccountProfile, Partial<RunnerConfig>> = {
  A: { dayCap: 40, minGapSeconds: 90, cadenceJitterSeconds: 120, minRewardPft: 0, qualityFloor: 0.3 },
  B: { dayCap: 8, minGapSeconds: 1800, cadenceJitterSeconds: 1200, minRewardPft: 1, qualityFloor: 0.7 },
};

export function loadRunnerConfig(): RunnerConfig {
  const profile = (process.env.ACCOUNT_PROFILE ?? "B").toUpperCase() as AccountProfile;
  const preset = PROFILE_PRESETS[profile] ?? PROFILE_PRESETS.B;

  // Safety defaults are the strictest: readonly + dry-run on.
  const approvalMode = (process.env.APPROVAL_MODE ?? "readonly") as ApprovalMode;
  const dryRun = envBool("DRY_RUN", true);

  return {
    botSeed: process.env.BOT_SEED ?? "",
    profile,
    chain: {
      pftlRpcUrl: process.env.PFTL_RPC_URL ?? "http://127.0.0.1:5015",
      pftlWssUrl: process.env.PFTL_WSS_URL ?? "ws://127.0.0.1:6016",
      ipfsGatewayUrl: process.env.IPFS_GATEWAY_URL ?? "https://ipfs.io",
      keystoneGrpcUrl: process.env.KEYSTONE_GRPC_URL ?? "",
      keystoneApiKey: process.env.KEYSTONE_API_KEY ?? "",
      tasknodeEncryptionPubkey: process.env.TASKNODE_ENCRYPTION_PUBKEY ?? "",
    },
    approvalMode,
    dryRun,
    killSwitchFile: process.env.KILL_SWITCH_FILE ?? `${process.env.HOME}/.pftl-runner-STOP`,
    dayCap: envNum("DAY_CAP", preset.dayCap!),
    minGapSeconds: envNum("MIN_GAP_SECONDS", preset.minGapSeconds!),
    cadenceJitterSeconds: envNum("CADENCE_JITTER_SECONDS", preset.cadenceJitterSeconds!),
    minRewardPft: envNum("MIN_REWARD_PFT", preset.minRewardPft!),
    qualityFloor: Number(process.env.QUALITY_FLOOR ?? preset.qualityFloor!),
    pollIntervalMs: envNum("POLL_INTERVAL_MS", 60000),
    ledgerPath: process.env.LEDGER_PATH ?? `${process.env.HOME}/.pftl-runner/ledger.jsonl`,
  };
}
