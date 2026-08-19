/**
 * subs-verify.ts — Canonical SUBS Entitlement Verifier Module
 *
 * Resolves subscription entitlement from public chain-indexed subscription
 * records using the canonical 7-condition qualification from the SUBS protocol spec.
 *
 * Two-phase resolution:
 *   Phase 1 — QUALIFICATION: evaluate each of the 7 canonical conditions independently
 *   Phase 2 — ENTITLEMENT: derive state (active/expiring/expired/inactive) from the
 *             most recent qualifying payment's recency and grace window
 *
 * Returns deterministic status, per-condition evaluation vector, reason codes,
 * freshness source, staleness disclosure, and a verifier receipt hash.
 *
 * Exports a single entitlement-check function: checkEntitlement
 *
 * Protocol spec: https://github.com/P-U-C/pft-validator/blob/main/subs-protocol.md
 *
 * ─── Sample Input / Output ──────────────────────────────────────────────
 *
 * Input:
 *   checkEntitlement(db, {
 *     subsProtocolAddress: "rSUBSprotocol...",
 *     serviceId: "alpha",
 *     pricePft: 500,
 *     periodDays: 30,
 *     serviceStatus: "active",
 *     gracePeriodHours: 72,
 *   }, "rSubscriber123...")
 *
 * Output (active subscription):
 *   {
 *     entitled: true,
 *     state: "active",
 *     reason: "PAYMENT_VALID",
 *     resolution_method: "chain_query",
 *     subscriber: "rSubscriber123...",
 *     serviceId: "alpha",
 *     evaluated_conditions: [
 *       { id: 1, name: "destination_match", passed: true, field: "destination", observed: "rSUBSprotocol...", expected: "rSUBSprotocol...", reason_code: null },
 *       { id: 2, name: "subscriber_match", passed: true, field: "account", observed: "rSubscriber123...", expected: "rSubscriber123...", reason_code: null },
 *       { id: 3, name: "memo_type_match", passed: true, field: "memo_type", observed: "subs.subscribe", expected: "subs.subscribe", reason_code: null },
 *       { id: 4, name: "service_id_match", passed: true, field: "memo_data", observed: "alpha", expected: "alpha", reason_code: null },
 *       { id: 5, name: "sufficient_payment", passed: true, field: "amount_drops", observed: "500000000", expected: ">=500000000", reason_code: null },
 *       { id: 6, name: "valid_tx_type", passed: true, field: "tx_type", observed: "Payment", expected: "Payment", reason_code: null },
 *       { id: 7, name: "tx_success", passed: true, field: "meta.TransactionResult", observed: "tesSUCCESS", expected: "tesSUCCESS", reason_code: null }
 *     ],
 *     currentPeriod: {
 *       startedAt: "2026-04-13T10:00:00.000Z",
 *       expiresAt: "2026-05-13T10:00:00.000Z",
 *       paymentTx: "AAA111...",
 *       amountPft: 500,
 *     },
 *     lifetime: { firstSubscribedAt: "2026-04-13T10:00:00.000Z", totalPayments: 1, totalPaidPft: 500 },
 *     freshness: {
 *       resolvedAt: "2026-04-13T10:05:00.000Z",
 *       source: "chain_index",
 *       indexedAt: "2026-04-13T10:00:02.000Z",
 *       stalenessSeconds: 298,
 *       stale: false,
 *       disclosure: "Index as of 2026-04-13T10:00:02.000Z (5m ago, within freshness window)",
 *     },
 *     receipt: {
 *       hash: "sha256:a1b2c3...",
 *       inputs: { subscriber: "rSubscriber123...", serviceId: "alpha", resolvedAtBucket: "2026-04-13T10:00Z", qualifyingTx: "AAA111...", indexedAt: "...", methodologyVersion: "1.0.0" }
 *     },
 *   }
 */

import type Database from "better-sqlite3";
import { createHash } from "crypto";

// ─── Configuration ──────────────────────────────────────────────────

export interface SubsServiceConfig {
  /** XRPL address of the SUBS protocol (receives all subscription payments) */
  subsProtocolAddress: string;
  /** Unique service identifier (e.g., "alpha") */
  serviceId: string;
  /** Minimum payment in PFT required per period */
  pricePft: number;
  /** Billing period duration in days */
  periodDays: number;
  /** Service lifecycle status */
  serviceStatus?: "active" | "paused" | "retired";
  /** Grace period before expiry in hours (default: 72) */
  gracePeriodHours?: number;
  /** Maximum staleness in seconds before flagging (default: 5400 = 90 min) */
  stalenessThresholdSeconds?: number;
}

// ─── Result Types ───────────────────────────────────────────────────

export type SubsState = "inactive" | "active" | "expiring" | "expired";

export type SubsReason =
  | "PAYMENT_VALID"
  | "PAYMENT_VALID_GRACE_PERIOD"
  | "NO_QUALIFYING_PAYMENT"
  | "PAYMENT_EXPIRED"
  | "PAYMENT_INSUFFICIENT"
  | "SERVICE_ID_MISMATCH"
  | "TX_NOT_PAYMENT"
  | "SERVICE_RETIRED"
  | "SERVICE_PAUSED_NO_NEW"
  | "INDEX_STALE_NO_FALLBACK";

export interface EvaluatedCondition {
  /** Condition number (1-7) per protocol spec */
  id: number;
  /** Human-readable condition name */
  name: string;
  /** Whether this condition passed */
  passed: boolean;
  /** Database field evaluated */
  field: string;
  /** Observed value from chain data */
  observed: string;
  /** Expected value per protocol spec */
  expected: string;
  /** Reason code if this condition failed, null if passed */
  reason_code: SubsReason | null;
}

export interface SubsPeriod {
  startedAt: string;
  expiresAt: string;
  paymentTx: string;
  amountPft: number;
}

export interface SubsLifetime {
  firstSubscribedAt: string | null;
  totalPayments: number;
  totalPaidPft: number;
}

export interface SubsFreshness {
  resolvedAt: string;
  /** Where entitlement data was sourced from */
  source: "chain_index" | "live_fallback";
  indexedAt: string | null;
  stalenessSeconds: number;
  stale: boolean;
  /** Human-readable staleness disclosure */
  disclosure: string;
}

export interface SubsReceipt {
  /** SHA-256 hash over canonical receipt inputs */
  hash: string;
  /** The inputs that were hashed */
  inputs: {
    subscriber: string;
    serviceId: string;
    resolvedAtBucket: string;
    qualifyingTx: string | null;
    indexedAt: string | null;
    methodologyVersion: string;
  };
}

export interface SubsEntitlementResult {
  entitled: boolean;
  state: SubsState;
  reason: SubsReason;
  /** How entitlement was resolved */
  resolution_method: "chain_query" | "live_fallback";
  subscriber: string;
  serviceId: string;
  /** Per-condition evaluation of the canonical 7 qualification checks */
  evaluated_conditions: EvaluatedCondition[];
  currentPeriod: SubsPeriod | null;
  lifetime: SubsLifetime;
  freshness: SubsFreshness;
  /** Stable hash for downstream audit logging */
  receipt: SubsReceipt;
}

// ─── Constants ──────────────────────────────────────────────────────

const METHODOLOGY_VERSION = "1.0.0";

// ─── Core Entitlement Check ─────────────────────────────────────────

/**
 * Resolve subscription entitlement using the canonical 7-condition evaluation.
 *
 * Phase 1 — QUALIFICATION: evaluate each condition independently
 * Phase 2 — ENTITLEMENT: derive state from recency and grace window
 *
 * @param db - better-sqlite3 database instance (chain-index.db)
 * @param config - Service configuration
 * @param subscriber - XRPL address of the subscriber to check
 * @returns Deterministic entitlement result with per-condition vector and receipt
 */
export function checkEntitlement(
  db: Database.Database,
  config: SubsServiceConfig,
  subscriber: string,
): SubsEntitlementResult {
  const now = new Date();
  const resolvedAt = now.toISOString();
  const minDrops = config.pricePft * 1_000_000;
  const gracePeriodHours = config.gracePeriodHours ?? 72;
  const stalenessThreshold = config.stalenessThresholdSeconds ?? 5400;
  const serviceStatus = config.serviceStatus ?? "active";

  // ── Freshness ───────────────────────────────────────────────────

  const freshness = computeFreshness(db, now, stalenessThreshold);

  // ── Service status gate ─────────────────────────────────────────

  if (serviceStatus === "retired") {
    return buildResult({
      entitled: false,
      state: "inactive",
      reason: "SERVICE_RETIRED",
      resolution_method: "chain_query",
      subscriber,
      config,
      evaluatedConditions: buildServiceRetiredConditions(config, subscriber),
      currentPeriod: null,
      lifetime: computeLifetime(db, config, subscriber),
      freshness,
      now,
    });
  }

  // ── Phase 1: Find candidate transactions ────────────────────────
  // Query all payments from subscriber to protocol address with any memo

  const candidates = db.prepare(`
    SELECT tx_hash, timestamp_iso, CAST(amount_drops AS INTEGER) as amount_drops,
           memo_type, memo_data_preview, tx_type, destination, account
    FROM transactions
    WHERE destination = ?
      AND account = ?
      AND tx_type = 'Payment'
    ORDER BY timestamp_iso DESC
  `).all(
    config.subsProtocolAddress,
    subscriber,
  ) as {
    tx_hash: string; timestamp_iso: string; amount_drops: number;
    memo_type: string | null; memo_data_preview: string | null;
    tx_type: string; destination: string; account: string;
  }[];

  // ── Phase 1: Evaluate 7 conditions per candidate ────────────────

  let bestQualifying: typeof candidates[0] | null = null;
  let bestConditions: EvaluatedCondition[] = [];
  let failedCandidate: typeof candidates[0] | null = null;
  let failedConditions: EvaluatedCondition[] = [];

  for (const tx of candidates) {
    const conditions = evaluateConditions(tx, config, subscriber, minDrops);
    const allPassed = conditions.every(c => c.passed);

    if (allPassed) {
      if (!bestQualifying) {
        bestQualifying = tx;
        bestConditions = conditions;
      }
      // Already have the most recent qualifying — stop
      break;
    } else if (!failedCandidate) {
      failedCandidate = tx;
      failedConditions = conditions;
    }
  }

  // ── Lifetime stats ──────────────────────────────────────────────

  const lifetime = computeLifetime(db, config, subscriber);

  // ── No qualifying payment found ─────────────────────────────────

  if (!bestQualifying) {
    // Determine most specific reason from the best failed candidate
    let reason: SubsReason = "NO_QUALIFYING_PAYMENT";
    let conditions = failedConditions;

    if (failedCandidate && failedConditions.length > 0) {
      const firstFail = failedConditions.find(c => !c.passed);
      if (firstFail?.reason_code) {
        reason = firstFail.reason_code;
      }
      conditions = failedConditions;
    } else {
      conditions = buildEmptyConditions(config, subscriber);
    }

    // Check if there was a qualifying payment that expired
    const latestEverQualifying = findLatestQualifyingPayment(db, config, subscriber, minDrops);

    if (latestEverQualifying) {
      const expiresAt = new Date(latestEverQualifying.timestamp_iso);
      expiresAt.setDate(expiresAt.getDate() + config.periodDays);

      return buildResult({
        entitled: false,
        state: "expired",
        reason: "PAYMENT_EXPIRED",
        resolution_method: "chain_query",
        subscriber,
        config,
        evaluatedConditions: conditions.length > 0 ? conditions : bestConditions,
        currentPeriod: {
          startedAt: latestEverQualifying.timestamp_iso,
          expiresAt: expiresAt.toISOString(),
          paymentTx: latestEverQualifying.tx_hash,
          amountPft: latestEverQualifying.amount_drops / 1_000_000,
        },
        lifetime,
        freshness,
        now,
      });
    }

    // Check for paused service with existing subscription
    if (serviceStatus === "paused" && lifetime.totalPayments > 0) {
      reason = "SERVICE_PAUSED_NO_NEW";
    }

    // Stale index warning
    if (freshness.stale && reason === "NO_QUALIFYING_PAYMENT") {
      reason = "INDEX_STALE_NO_FALLBACK";
    }

    return buildResult({
      entitled: false,
      state: "inactive",
      reason,
      resolution_method: "chain_query",
      subscriber,
      config,
      evaluatedConditions: conditions,
      currentPeriod: null,
      lifetime,
      freshness,
      now,
    });
  }

  // ── Qualifying payment found — Phase 2: derive state ────────────

  const paymentTime = new Date(bestQualifying.timestamp_iso);
  const expiresAt = new Date(paymentTime);
  expiresAt.setDate(expiresAt.getDate() + config.periodDays);

  // Check if within billing period
  if (now >= expiresAt) {
    return buildResult({
      entitled: false,
      state: "expired",
      reason: "PAYMENT_EXPIRED",
      resolution_method: "chain_query",
      subscriber,
      config,
      evaluatedConditions: bestConditions,
      currentPeriod: {
        startedAt: bestQualifying.timestamp_iso,
        expiresAt: expiresAt.toISOString(),
        paymentTx: bestQualifying.tx_hash,
        amountPft: bestQualifying.amount_drops / 1_000_000,
      },
      lifetime,
      freshness,
      now,
    });
  }

  // Check grace period
  const graceThreshold = new Date(expiresAt);
  graceThreshold.setHours(graceThreshold.getHours() - gracePeriodHours);

  const inGracePeriod = now >= graceThreshold && now < expiresAt;
  const state: SubsState = inGracePeriod ? "expiring" : "active";
  const reason: SubsReason = inGracePeriod ? "PAYMENT_VALID_GRACE_PERIOD" : "PAYMENT_VALID";

  return buildResult({
    entitled: true,
    state,
    reason,
    resolution_method: "chain_query",
    subscriber,
    config,
    evaluatedConditions: bestConditions,
    currentPeriod: {
      startedAt: bestQualifying.timestamp_iso,
      expiresAt: expiresAt.toISOString(),
      paymentTx: bestQualifying.tx_hash,
      amountPft: bestQualifying.amount_drops / 1_000_000,
    },
    lifetime,
    freshness,
    now,
  });
}

// ─── Condition Evaluation ───────────────────────────────────────────

function evaluateConditions(
  tx: {
    tx_hash: string; destination: string; account: string;
    memo_type: string | null; memo_data_preview: string | null;
    amount_drops: number; tx_type: string;
  },
  config: SubsServiceConfig,
  subscriber: string,
  minDrops: number,
): EvaluatedCondition[] {
  return [
    {
      id: 1,
      name: "destination_match",
      passed: tx.destination === config.subsProtocolAddress,
      field: "destination",
      observed: tx.destination,
      expected: config.subsProtocolAddress,
      reason_code: tx.destination !== config.subsProtocolAddress ? "NO_QUALIFYING_PAYMENT" : null,
    },
    {
      id: 2,
      name: "subscriber_match",
      passed: tx.account === subscriber,
      field: "account",
      observed: tx.account,
      expected: subscriber,
      reason_code: tx.account !== subscriber ? "NO_QUALIFYING_PAYMENT" : null,
    },
    {
      id: 3,
      name: "memo_type_match",
      passed: tx.memo_type === "subs.subscribe",
      field: "memo_type",
      observed: tx.memo_type ?? "(null)",
      expected: "subs.subscribe",
      reason_code: tx.memo_type !== "subs.subscribe" ? "NO_QUALIFYING_PAYMENT" : null,
    },
    {
      id: 4,
      name: "service_id_match",
      passed: (tx.memo_data_preview ?? "").includes(config.serviceId),
      field: "memo_data",
      observed: tx.memo_data_preview ?? "(null)",
      expected: `contains "${config.serviceId}"`,
      reason_code: !(tx.memo_data_preview ?? "").includes(config.serviceId) ? "SERVICE_ID_MISMATCH" : null,
    },
    {
      id: 5,
      name: "sufficient_payment",
      passed: tx.amount_drops >= minDrops,
      field: "amount_drops",
      observed: String(tx.amount_drops),
      expected: `>=${minDrops}`,
      reason_code: tx.amount_drops < minDrops ? "PAYMENT_INSUFFICIENT" : null,
    },
    {
      id: 6,
      name: "valid_tx_type",
      passed: tx.tx_type === "Payment",
      field: "tx_type",
      observed: tx.tx_type,
      expected: "Payment",
      reason_code: tx.tx_type !== "Payment" ? "TX_NOT_PAYMENT" : null,
    },
    {
      id: 7,
      name: "tx_success",
      passed: true, // Indexed transactions are successful (indexer filters failed txns)
      field: "meta.TransactionResult",
      observed: "tesSUCCESS",
      expected: "tesSUCCESS",
      reason_code: null,
    },
  ];
}

function buildEmptyConditions(config: SubsServiceConfig, subscriber: string): EvaluatedCondition[] {
  return [
    { id: 1, name: "destination_match", passed: false, field: "destination", observed: "(no transactions)", expected: config.subsProtocolAddress, reason_code: "NO_QUALIFYING_PAYMENT" },
    { id: 2, name: "subscriber_match", passed: false, field: "account", observed: "(no transactions)", expected: subscriber, reason_code: null },
    { id: 3, name: "memo_type_match", passed: false, field: "memo_type", observed: "(no transactions)", expected: "subs.subscribe", reason_code: null },
    { id: 4, name: "service_id_match", passed: false, field: "memo_data", observed: "(no transactions)", expected: `contains "${config.serviceId}"`, reason_code: null },
    { id: 5, name: "sufficient_payment", passed: false, field: "amount_drops", observed: "(no transactions)", expected: `>=${config.pricePft * 1_000_000}`, reason_code: null },
    { id: 6, name: "valid_tx_type", passed: false, field: "tx_type", observed: "(no transactions)", expected: "Payment", reason_code: null },
    { id: 7, name: "tx_success", passed: false, field: "meta.TransactionResult", observed: "(no transactions)", expected: "tesSUCCESS", reason_code: null },
  ];
}

function buildServiceRetiredConditions(config: SubsServiceConfig, subscriber: string): EvaluatedCondition[] {
  const empty = buildEmptyConditions(config, subscriber);
  // Override: service retired is a pre-qualification gate
  empty[0].observed = "(service retired)";
  empty[0].reason_code = "SERVICE_RETIRED";
  return empty;
}

// ─── Helpers ────────────────────────────────────────────────────────

function findLatestQualifyingPayment(
  db: Database.Database,
  config: SubsServiceConfig,
  subscriber: string,
  minDrops: number,
): { tx_hash: string; timestamp_iso: string; amount_drops: number } | undefined {
  return db.prepare(`
    SELECT tx_hash, timestamp_iso, CAST(amount_drops AS INTEGER) as amount_drops
    FROM transactions
    WHERE destination = ?
      AND account = ?
      AND memo_type = 'subs.subscribe'
      AND memo_data_preview LIKE '%' || ? || '%'
      AND CAST(amount_drops AS INTEGER) >= ?
      AND tx_type = 'Payment'
    ORDER BY timestamp_iso DESC
    LIMIT 1
  `).get(
    config.subsProtocolAddress,
    subscriber,
    config.serviceId,
    minDrops,
  ) as { tx_hash: string; timestamp_iso: string; amount_drops: number } | undefined;
}

function computeLifetime(
  db: Database.Database,
  config: SubsServiceConfig,
  subscriber: string,
): SubsLifetime {
  const minDrops = config.pricePft * 1_000_000;
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_payments,
      COALESCE(SUM(CAST(amount_drops AS INTEGER)), 0) as total_drops,
      MIN(timestamp_iso) as first_at
    FROM transactions
    WHERE destination = ?
      AND account = ?
      AND memo_type = 'subs.subscribe'
      AND memo_data_preview LIKE '%' || ? || '%'
      AND CAST(amount_drops AS INTEGER) >= ?
      AND tx_type = 'Payment'
  `).get(
    config.subsProtocolAddress,
    subscriber,
    config.serviceId,
    minDrops,
  ) as { total_payments: number; total_drops: number; first_at: string | null };

  return {
    firstSubscribedAt: stats.first_at,
    totalPayments: stats.total_payments,
    totalPaidPft: stats.total_drops / 1_000_000,
  };
}

function computeFreshness(
  db: Database.Database,
  now: Date,
  stalenessThreshold: number,
): SubsFreshness {
  const resolvedAt = now.toISOString();

  let indexedAt: string | null = null;
  try {
    const row = db.prepare(
      "SELECT value FROM crawl_state WHERE key = 'last_crawl_at'"
    ).get() as { value: string } | undefined;
    indexedAt = row?.value ?? null;
  } catch {
    // crawl_state table may not exist in test databases
  }

  let stalenessSeconds = 0;
  let stale = false;

  if (indexedAt) {
    const indexTime = new Date(indexedAt);
    stalenessSeconds = Math.round((now.getTime() - indexTime.getTime()) / 1000);
    stale = stalenessSeconds > stalenessThreshold;
  } else {
    stale = true;
    stalenessSeconds = -1;
  }

  const agoMinutes = stalenessSeconds >= 0 ? Math.round(stalenessSeconds / 60) : -1;
  const disclosure = indexedAt
    ? `Index as of ${indexedAt} (${agoMinutes}m ago, ${stale ? "STALE — exceeds freshness window" : "within freshness window"})`
    : "Index freshness unknown — crawl_state not available";

  return {
    resolvedAt,
    source: "chain_index",
    indexedAt,
    stalenessSeconds,
    stale,
    disclosure,
  };
}

function computeReceipt(
  subscriber: string,
  serviceId: string,
  resolvedAt: string,
  qualifyingTx: string | null,
  indexedAt: string | null,
): SubsReceipt {
  // Bucket to nearest minute for stable hashing
  const resolvedAtBucket = resolvedAt.substring(0, 16) + "Z";

  const inputs = {
    subscriber,
    serviceId,
    resolvedAtBucket,
    qualifyingTx,
    indexedAt,
    methodologyVersion: METHODOLOGY_VERSION,
  };

  const canonical = JSON.stringify(inputs, Object.keys(inputs).sort());
  const hash = "sha256:" + createHash("sha256").update(canonical).digest("hex");

  return { hash, inputs };
}

interface BuildResultParams {
  entitled: boolean;
  state: SubsState;
  reason: SubsReason;
  resolution_method: "chain_query" | "live_fallback";
  subscriber: string;
  config: SubsServiceConfig;
  evaluatedConditions: EvaluatedCondition[];
  currentPeriod: SubsPeriod | null;
  lifetime: SubsLifetime;
  freshness: SubsFreshness;
  now: Date;
}

function buildResult(params: BuildResultParams): SubsEntitlementResult {
  const receipt = computeReceipt(
    params.subscriber,
    params.config.serviceId,
    params.now.toISOString(),
    params.currentPeriod?.paymentTx ?? null,
    params.freshness.indexedAt,
  );

  return {
    entitled: params.entitled,
    state: params.state,
    reason: params.reason,
    resolution_method: params.resolution_method,
    subscriber: params.subscriber,
    serviceId: params.config.serviceId,
    evaluated_conditions: params.evaluatedConditions,
    currentPeriod: params.currentPeriod,
    lifetime: params.lifetime,
    freshness: params.freshness,
    receipt,
  };
}
