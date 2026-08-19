/**
 * subs-router.ts — SUBS Payment Router Settlement Core
 *
 * Routes incoming subscription payments: validates against the service registry,
 * retains protocol fee via floor(amount × 0.025), forwards the remainder to the
 * provider with auditable subs.forward memo linking to the source transaction.
 *
 * Two-phase architecture:
 *   Phase 1 — VALIDATION: evaluate registry rules, payment shape, duplicate status
 *   Phase 2 — SETTLEMENT: compute fee split, build forward intent, write record
 *
 * Exports a single routing function: routeSubscriptionPayment
 *
 * Protocol spec: https://github.com/P-U-C/pft-validator/blob/main/subs-protocol.md
 *
 * ─── Sample Input / Output ──────────────────────────────────────────────
 *
 * Input:
 *   routeSubscriptionPayment(db, registry, {
 *     tx_hash: "AAA111...",
 *     ledger_index: 1850000,
 *     account: "rSubscriber...",
 *     destination: "rSUBSprotocol...",
 *     amount_drops: "500000000",
 *     memo_type: "subs.subscribe",
 *     memo_data: "alpha",
 *     timestamp_iso: "2026-04-13T10:00:00Z",
 *   })
 *
 * Output (forwarded):
 *   {
 *     decision: "forwarded",
 *     reason_codes: [],
 *     source_tx_hash: "AAA111...",
 *     source_ledger_index: 1850000,
 *     registry_validation: {
 *       status: "passed",
 *       evaluated_rules: [ { rule: "service_exists", passed: true, ... }, ... ]
 *     },
 *     fee_split: {
 *       gross_amount_drops: 500000000,
 *       protocol_fee_drops: 12500000,
 *       forward_amount_drops: 487500000,
 *       fee_bps: 250,
 *       rounding_policy: "floor",
 *     },
 *     forward_intent: {
 *       provider_destination: "rProvider...",
 *       forward_amount_drops: 487500000,
 *       memo: { type: "subs.forward", data: { ... } },
 *     },
 *     duplicate_guard: { duplicate: false, idempotency_key: "sha256:...", ... },
 *     settlement_record: { settlement_id: "STL-AAA111...", ... },
 *     settlement_posture: "safe_to_broadcast",
 *     receipt: { hash: "sha256:...", inputs: { ... } },
 *   }
 */

import type Database from "better-sqlite3";
import { createHash } from "crypto";

// ─── Constants ──────────────────────────────────────────────────────

const PROTOCOL_FEE_BPS = 250; // 2.5% = 250 basis points
const PROTOCOL_FEE_RATE = PROTOCOL_FEE_BPS / 10000;
const MEMO_TYPE_SUBSCRIBE = "subs.subscribe";
const MEMO_TYPE_FORWARD = "subs.forward";
const ROUTER_VERSION = "1.0.0";
const MIN_FORWARD_DROPS = 1000; // Minimum viable forward (dust threshold)

// ─── Service Registry Types ─────────────────────────────────────────

export interface ServiceRegistryEntry {
  serviceId: string;
  name: string;
  providerAddress: string;
  priceDrops: number;
  periodDays: number;
  status: "active" | "paused" | "retired";
}

export interface ServiceRegistry {
  services: ServiceRegistryEntry[];
  protocolAddress: string;
  treasuryAddress: string;
  feeRate: number;
}

// ─── Input Types ────────────────────────────────────────────────────

export interface SourceTransaction {
  tx_hash: string;
  ledger_index: number;
  account: string;
  destination: string;
  amount_drops: string;
  memo_type: string;
  memo_data: string;
  timestamp_iso: string;
}

// ─── Output Types ───────────────────────────────────────────────────

export type RoutingDecision = "forwarded" | "rejected" | "duplicate" | "held";

export type ReasonCode =
  | "SERVICE_NOT_FOUND"
  | "SERVICE_RETIRED"
  | "SERVICE_PAUSED"
  | "INSUFFICIENT_PAYMENT"
  | "DUST_AMOUNT"
  | "WRONG_DESTINATION"
  | "INVALID_MEMO_TYPE"
  | "EMPTY_SERVICE_ID"
  | "PROVIDER_ADDRESS_MISSING"
  | "DUPLICATE_SOURCE_TX"
  | "DUPLICATE_IDEMPOTENCY_KEY"
  | "FORWARD_BROADCAST_FAILED";

export type RejectionDomain =
  | "registry"
  | "payment_shape"
  | "duplicate"
  | "downstream";

export interface EvaluatedRule {
  rule: string;
  passed: boolean;
  field: string;
  observed: string;
  expected: string;
  reason_code: ReasonCode | null;
  domain: RejectionDomain;
}

export interface RegistryValidation {
  status: "passed" | "failed";
  evaluated_rules: EvaluatedRule[];
  first_failure: ReasonCode | null;
}

export interface FeeSplit {
  gross_amount_drops: number;
  protocol_fee_drops: number;
  forward_amount_drops: number;
  fee_bps: number;
  rounding_policy: "floor";
  formula: "protocol_fee_drops = floor(gross_amount_drops * fee_bps / 10000)";
}

export interface ForwardMemoPayload {
  source_tx_hash: string;
  source_ledger_index: number;
  service_id: string;
  subscriber: string;
  provider: string;
  gross_amount_drops: number;
  protocol_fee_drops: number;
  forward_amount_drops: number;
  router_version: string;
  settlement_id: string;
}

export interface ForwardIntent {
  provider_destination: string;
  forward_amount_drops: number;
  memo: {
    type: typeof MEMO_TYPE_FORWARD;
    data: ForwardMemoPayload;
    data_canonical: string;
  };
}

export interface DuplicateGuard {
  duplicate: boolean;
  idempotency_key: string;
  branch: "NONE" | "DUPLICATE_SOURCE_TX" | "DUPLICATE_IDEMPOTENCY_KEY";
  prior_settlement_id: string | null;
  prior_decision: RoutingDecision | null;
  replay_risk: "blocked" | "low";
  replay_basis: string;
}

export type SettlementPosture =
  | "safe_to_broadcast"
  | "requires_manual_review"
  | "reject_do_not_retry"
  | "retry_forward";

export interface SettlementReceipt {
  hash: string;
  inputs: {
    source_tx_hash: string;
    service_id: string;
    subscriber: string;
    provider: string | null;
    gross_amount_drops: number;
    protocol_fee_drops: number;
    router_version: string;
    settled_at_bucket: string;
  };
}

export interface SettlementRecord {
  settlement_id: string;
  source_tx_hash: string;
  source_ledger_index: number;
  subscriber: string;
  service_id: string;
  provider_address: string | null;
  gross_amount_drops: number;
  protocol_fee_drops: number;
  forward_amount_drops: number;
  decision: RoutingDecision;
  reason_codes: ReasonCode[];
  rejection_domain: RejectionDomain | null;
  forward_tx_hash: string | null;
  forward_memo_canonical: string | null;
  idempotency_key: string;
  registry_snapshot_hash: string;
  settled_at: string;
  router_version: string;
}

export interface RoutingResult {
  decision: RoutingDecision;
  reason_codes: ReasonCode[];
  rejection_domain: RejectionDomain | null;
  source_tx_hash: string;
  source_ledger_index: number;
  subscriber: string;
  service_id: string;
  registry_validation: RegistryValidation;
  fee_split: FeeSplit;
  forward_intent: ForwardIntent | null;
  duplicate_guard: DuplicateGuard;
  settlement_record: SettlementRecord;
  settlement_posture: SettlementPosture;
  receipt: SettlementReceipt;
}

// ─── Settlement Schema ──────────────────────────────────────────────

/**
 * Ensure the subs_settlements table exists. Call once at startup.
 *
 * Schema:
 *   settlement_id          TEXT PRIMARY KEY  — "STL-{source_tx_hash}"
 *   source_tx_hash         TEXT UNIQUE       — original subscription payment hash
 *   source_ledger_index    INTEGER           — ledger containing the source tx
 *   subscriber             TEXT              — subscriber XRPL address
 *   service_id             TEXT              — service identifier from memo_data
 *   provider_address       TEXT              — provider who receives forwarded funds
 *   gross_amount_drops     INTEGER           — original payment amount
 *   protocol_fee_drops     INTEGER           — retained fee: floor(gross × 0.025)
 *   forward_amount_drops   INTEGER           — gross - fee, sent to provider
 *   decision               TEXT              — forwarded | rejected | duplicate | held
 *   reason_codes           TEXT              — JSON array of reason codes
 *   rejection_domain       TEXT              — registry | payment_shape | duplicate | downstream | null
 *   forward_tx_hash        TEXT              — hash of forwarding tx, null if not broadcast
 *   forward_memo_canonical TEXT              — canonical memo payload on forward tx
 *   idempotency_key        TEXT UNIQUE       — sha256 dedup key
 *   registry_snapshot_hash TEXT              — hash of registry state at decision time
 *   settled_at             TEXT              — ISO timestamp of settlement
 *   router_version         TEXT              — version of this module
 */
export function ensureSettlementSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subs_settlements (
      settlement_id TEXT PRIMARY KEY,
      source_tx_hash TEXT NOT NULL UNIQUE,
      source_ledger_index INTEGER NOT NULL,
      subscriber TEXT NOT NULL,
      service_id TEXT NOT NULL,
      provider_address TEXT,
      gross_amount_drops INTEGER NOT NULL,
      protocol_fee_drops INTEGER NOT NULL,
      forward_amount_drops INTEGER NOT NULL,
      decision TEXT NOT NULL,
      reason_codes TEXT NOT NULL DEFAULT '[]',
      rejection_domain TEXT,
      forward_tx_hash TEXT,
      forward_memo_canonical TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      registry_snapshot_hash TEXT NOT NULL,
      settled_at TEXT NOT NULL,
      router_version TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stl_subscriber ON subs_settlements(subscriber);
    CREATE INDEX IF NOT EXISTS idx_stl_service ON subs_settlements(service_id);
    CREATE INDEX IF NOT EXISTS idx_stl_decision ON subs_settlements(decision);
  `);
}

// ─── Fee Calculation ────────────────────────────────────────────────

/**
 * Compute protocol fee split.
 * Formula: protocol_fee_drops = floor(gross_amount_drops × fee_bps / 10000)
 * Deterministic: same inputs always produce same outputs.
 * No drops are created or destroyed: fee + forward = gross.
 */
export function splitProtocolFee(grossAmountDrops: number, feeBps: number = PROTOCOL_FEE_BPS): FeeSplit {
  const protocolFeeDrops = Math.floor(grossAmountDrops * feeBps / 10000);
  const forwardAmountDrops = grossAmountDrops - protocolFeeDrops;
  return {
    gross_amount_drops: grossAmountDrops,
    protocol_fee_drops: protocolFeeDrops,
    forward_amount_drops: forwardAmountDrops,
    fee_bps: feeBps,
    rounding_policy: "floor",
    formula: "protocol_fee_drops = floor(gross_amount_drops * fee_bps / 10000)",
  };
}

// ─── Idempotency Key ────────────────────────────────────────────────

function computeIdempotencyKey(
  sourceTxHash: string,
  serviceId: string,
  providerAddress: string,
  grossAmountDrops: number,
  memoCanonical: string,
): string {
  const input = `${sourceTxHash}|${serviceId}|${providerAddress}|${grossAmountDrops}|${memoCanonical}`;
  return "sha256:" + createHash("sha256").update(input).digest("hex");
}

// ─── Registry Snapshot Hash ─────────────────────────────────────────

function hashRegistrySnapshot(registry: ServiceRegistry): string {
  const canonical = JSON.stringify(registry.services.map(s => s.serviceId).sort());
  return "sha256:" + createHash("sha256").update(canonical).digest("hex").substring(0, 16);
}

// ─── Receipt ────────────────────────────────────────────────────────

function computeReceipt(
  record: SettlementRecord,
): SettlementReceipt {
  const settledAtBucket = record.settled_at.substring(0, 16) + "Z";
  const inputs = {
    source_tx_hash: record.source_tx_hash,
    service_id: record.service_id,
    subscriber: record.subscriber,
    provider: record.provider_address,
    gross_amount_drops: record.gross_amount_drops,
    protocol_fee_drops: record.protocol_fee_drops,
    router_version: ROUTER_VERSION,
    settled_at_bucket: settledAtBucket,
  };
  const canonical = JSON.stringify(inputs, Object.keys(inputs).sort());
  const hash = "sha256:" + createHash("sha256").update(canonical).digest("hex");
  return { hash, inputs };
}

// ─── Registry Validation ────────────────────────────────────────────

function validateRegistry(
  registry: ServiceRegistry,
  sourceTx: SourceTransaction,
  serviceId: string,
  grossDrops: number,
): RegistryValidation {
  const service = registry.services.find(s => s.serviceId === serviceId) ?? null;

  const rules: EvaluatedRule[] = [
    {
      rule: "protocol_destination_match",
      passed: sourceTx.destination === registry.protocolAddress,
      field: "destination",
      observed: sourceTx.destination,
      expected: registry.protocolAddress,
      reason_code: sourceTx.destination !== registry.protocolAddress ? "WRONG_DESTINATION" : null,
      domain: "payment_shape",
    },
    {
      rule: "memo_type_valid",
      passed: sourceTx.memo_type === MEMO_TYPE_SUBSCRIBE,
      field: "memo_type",
      observed: sourceTx.memo_type ?? "(null)",
      expected: MEMO_TYPE_SUBSCRIBE,
      reason_code: sourceTx.memo_type !== MEMO_TYPE_SUBSCRIBE ? "INVALID_MEMO_TYPE" : null,
      domain: "payment_shape",
    },
    {
      rule: "service_id_present",
      passed: serviceId.length > 0,
      field: "memo_data",
      observed: serviceId || "(empty)",
      expected: "non-empty service_id",
      reason_code: serviceId.length === 0 ? "EMPTY_SERVICE_ID" : null,
      domain: "payment_shape",
    },
    {
      rule: "service_exists",
      passed: service !== null,
      field: "service_registry",
      observed: service ? service.serviceId : "(not found)",
      expected: serviceId,
      reason_code: service === null ? "SERVICE_NOT_FOUND" : null,
      domain: "registry",
    },
    {
      rule: "service_active",
      passed: service?.status === "active",
      field: "service_status",
      observed: service?.status ?? "(null)",
      expected: "active",
      reason_code: service?.status === "retired" ? "SERVICE_RETIRED" :
                   service?.status === "paused" ? "SERVICE_PAUSED" : (service ? null : null),
      domain: "registry",
    },
    {
      rule: "provider_address_present",
      passed: (service?.providerAddress ?? "").length > 0,
      field: "provider_address",
      observed: service?.providerAddress ?? "(null)",
      expected: "non-empty XRPL address",
      reason_code: !(service?.providerAddress) ? "PROVIDER_ADDRESS_MISSING" : null,
      domain: "registry",
    },
    {
      rule: "sufficient_payment",
      passed: service ? grossDrops >= service.priceDrops : false,
      field: "amount_drops",
      observed: String(grossDrops),
      expected: service ? `>=${service.priceDrops}` : "(unknown)",
      reason_code: service && grossDrops < service.priceDrops ? "INSUFFICIENT_PAYMENT" : null,
      domain: "payment_shape",
    },
    {
      rule: "above_dust_threshold",
      passed: grossDrops >= MIN_FORWARD_DROPS,
      field: "amount_drops",
      observed: String(grossDrops),
      expected: `>=${MIN_FORWARD_DROPS}`,
      reason_code: grossDrops < MIN_FORWARD_DROPS ? "DUST_AMOUNT" : null,
      domain: "payment_shape",
    },
  ];

  const firstFailed = rules.find(r => !r.passed);
  return {
    status: firstFailed ? "failed" : "passed",
    evaluated_rules: rules,
    first_failure: firstFailed?.reason_code ?? null,
  };
}

// ─── Duplicate Guard ────────────────────────────────────────────────

function checkDuplicate(
  db: Database.Database,
  sourceTxHash: string,
  idempotencyKey: string,
): DuplicateGuard {
  // Check source tx hash first
  const byTx = db.prepare(
    "SELECT settlement_id, decision FROM subs_settlements WHERE source_tx_hash = ?"
  ).get(sourceTxHash) as { settlement_id: string; decision: string } | undefined;

  if (byTx) {
    return {
      duplicate: true,
      idempotency_key: idempotencyKey,
      branch: "DUPLICATE_SOURCE_TX",
      prior_settlement_id: byTx.settlement_id,
      prior_decision: byTx.decision as RoutingDecision,
      replay_risk: "blocked",
      replay_basis: `Source tx ${sourceTxHash} already settled as ${byTx.settlement_id}`,
    };
  }

  // Check idempotency key
  const byKey = db.prepare(
    "SELECT settlement_id, decision FROM subs_settlements WHERE idempotency_key = ?"
  ).get(idempotencyKey) as { settlement_id: string; decision: string } | undefined;

  if (byKey) {
    return {
      duplicate: true,
      idempotency_key: idempotencyKey,
      branch: "DUPLICATE_IDEMPOTENCY_KEY",
      prior_settlement_id: byKey.settlement_id,
      prior_decision: byKey.decision as RoutingDecision,
      replay_risk: "blocked",
      replay_basis: `Idempotency key collision with ${byKey.settlement_id}`,
    };
  }

  return {
    duplicate: false,
    idempotency_key: idempotencyKey,
    branch: "NONE",
    prior_settlement_id: null,
    prior_decision: null,
    replay_risk: "low",
    replay_basis: "No prior settlement found for this source tx or idempotency key",
  };
}

// ─── Write Settlement ───────────────────────────────────────────────

function writeSettlement(db: Database.Database, record: SettlementRecord): void {
  db.prepare(`
    INSERT INTO subs_settlements
    (settlement_id, source_tx_hash, source_ledger_index, subscriber, service_id,
     provider_address, gross_amount_drops, protocol_fee_drops, forward_amount_drops,
     decision, reason_codes, rejection_domain, forward_tx_hash, forward_memo_canonical,
     idempotency_key, registry_snapshot_hash, settled_at, router_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.settlement_id, record.source_tx_hash, record.source_ledger_index,
    record.subscriber, record.service_id, record.provider_address,
    record.gross_amount_drops, record.protocol_fee_drops, record.forward_amount_drops,
    record.decision, JSON.stringify(record.reason_codes), record.rejection_domain,
    record.forward_tx_hash, record.forward_memo_canonical,
    record.idempotency_key, record.registry_snapshot_hash,
    record.settled_at, record.router_version,
  );
}

// ─── Core: Route a Subscription Payment ─────────────────────────────

/**
 * Route a single subscription payment through the SUBS settlement core.
 *
 * Phase 1 — VALIDATION: registry rules, payment shape, duplicate check
 * Phase 2 — SETTLEMENT: fee split, forward intent, settlement record
 *
 * @param db - chain-index.db with subs_settlements table
 * @param registry - live service registry snapshot
 * @param sourceTx - the incoming subscription payment
 * @param broadcastResult - result of actually broadcasting the forward tx (null for dry-run)
 * @returns Full routing result with all decision surfaces
 */
export function routeSubscriptionPayment(
  db: Database.Database,
  registry: ServiceRegistry,
  sourceTx: SourceTransaction,
  broadcastResult?: { tx_hash: string; success: boolean } | null,
): RoutingResult {
  const now = new Date().toISOString();
  const serviceId = (sourceTx.memo_data ?? "").trim();
  const grossDrops = parseInt(sourceTx.amount_drops, 10) || 0;
  const settlementId = `STL-${sourceTx.tx_hash}`;
  const service = registry.services.find(s => s.serviceId === serviceId) ?? null;
  const providerAddress = service?.providerAddress ?? "";
  const registryHash = hashRegistrySnapshot(registry);

  // Forward memo canonical form (used for idempotency key even if rejected)
  const memoCanonical = `${serviceId}:${sourceTx.tx_hash}`;
  const idempotencyKey = computeIdempotencyKey(
    sourceTx.tx_hash, serviceId, providerAddress, grossDrops, memoCanonical,
  );

  // ── Phase 1a: Duplicate guard ───────────────────────────────────

  const duplicateGuard = checkDuplicate(db, sourceTx.tx_hash, idempotencyKey);

  if (duplicateGuard.duplicate) {
    const reasonCode = duplicateGuard.branch === "DUPLICATE_SOURCE_TX"
      ? "DUPLICATE_SOURCE_TX" as ReasonCode
      : "DUPLICATE_IDEMPOTENCY_KEY" as ReasonCode;

    const feeSplit = splitProtocolFee(grossDrops, registry.feeRate * 10000);
    const validation = validateRegistry(registry, sourceTx, serviceId, grossDrops);

    const record: SettlementRecord = {
      settlement_id: settlementId,
      source_tx_hash: sourceTx.tx_hash,
      source_ledger_index: sourceTx.ledger_index,
      subscriber: sourceTx.account,
      service_id: serviceId,
      provider_address: providerAddress || null,
      gross_amount_drops: grossDrops,
      protocol_fee_drops: 0,
      forward_amount_drops: 0,
      decision: "duplicate",
      reason_codes: [reasonCode],
      rejection_domain: "duplicate",
      forward_tx_hash: null,
      forward_memo_canonical: null,
      idempotency_key: idempotencyKey,
      registry_snapshot_hash: registryHash,
      settled_at: now,
      router_version: ROUTER_VERSION,
    };
    // Do NOT write duplicate — original record already exists

    return {
      decision: "duplicate",
      reason_codes: [reasonCode],
      rejection_domain: "duplicate",
      source_tx_hash: sourceTx.tx_hash,
      source_ledger_index: sourceTx.ledger_index,
      subscriber: sourceTx.account,
      service_id: serviceId,
      registry_validation: validation,
      fee_split: feeSplit,
      forward_intent: null,
      duplicate_guard: duplicateGuard,
      settlement_record: record,
      settlement_posture: "reject_do_not_retry",
      receipt: computeReceipt(record),
    };
  }

  // ── Phase 1b: Registry + payment validation ─────────────────────

  const validation = validateRegistry(registry, sourceTx, serviceId, grossDrops);

  if (validation.status === "failed") {
    const reasonCodes = validation.evaluated_rules
      .filter(r => !r.passed && r.reason_code)
      .map(r => r.reason_code!);
    const firstFail = validation.evaluated_rules.find(r => !r.passed);
    const domain = firstFail?.domain ?? "registry";

    const feeSplit = splitProtocolFee(grossDrops, registry.feeRate * 10000);

    const record: SettlementRecord = {
      settlement_id: settlementId,
      source_tx_hash: sourceTx.tx_hash,
      source_ledger_index: sourceTx.ledger_index,
      subscriber: sourceTx.account,
      service_id: serviceId,
      provider_address: providerAddress || null,
      gross_amount_drops: grossDrops,
      protocol_fee_drops: 0,
      forward_amount_drops: 0,
      decision: "rejected",
      reason_codes: reasonCodes,
      rejection_domain: domain,
      forward_tx_hash: null,
      forward_memo_canonical: null,
      idempotency_key: idempotencyKey,
      registry_snapshot_hash: registryHash,
      settled_at: now,
      router_version: ROUTER_VERSION,
    };

    writeSettlement(db, record);

    return {
      decision: "rejected",
      reason_codes: reasonCodes,
      rejection_domain: domain,
      source_tx_hash: sourceTx.tx_hash,
      source_ledger_index: sourceTx.ledger_index,
      subscriber: sourceTx.account,
      service_id: serviceId,
      registry_validation: validation,
      fee_split: feeSplit,
      forward_intent: null,
      duplicate_guard: duplicateGuard,
      settlement_record: record,
      settlement_posture: "reject_do_not_retry",
      receipt: computeReceipt(record),
    };
  }

  // ── Phase 2: Fee split ──────────────────────────────────────────

  const feeSplit = splitProtocolFee(grossDrops, registry.feeRate * 10000);

  // ── Phase 2: Forward intent ─────────────────────────────────────

  const forwardMemoPayload: ForwardMemoPayload = {
    source_tx_hash: sourceTx.tx_hash,
    source_ledger_index: sourceTx.ledger_index,
    service_id: serviceId,
    subscriber: sourceTx.account,
    provider: providerAddress,
    gross_amount_drops: grossDrops,
    protocol_fee_drops: feeSplit.protocol_fee_drops,
    forward_amount_drops: feeSplit.forward_amount_drops,
    router_version: ROUTER_VERSION,
    settlement_id: settlementId,
  };

  const forwardMemoCanonical = JSON.stringify(forwardMemoPayload, Object.keys(forwardMemoPayload).sort());

  const forwardIntent: ForwardIntent = {
    provider_destination: providerAddress,
    forward_amount_drops: feeSplit.forward_amount_drops,
    memo: {
      type: MEMO_TYPE_FORWARD,
      data: forwardMemoPayload,
      data_canonical: forwardMemoCanonical,
    },
  };

  // ── Phase 2: Determine decision from broadcast result ───────────

  let decision: RoutingDecision;
  let forwardTxHash: string | null = null;
  let posture: SettlementPosture;
  const reasonCodes: ReasonCode[] = [];

  if (broadcastResult === undefined || broadcastResult === null) {
    // Dry-run or broadcast not attempted yet
    decision = "held";
    posture = "safe_to_broadcast";
  } else if (broadcastResult.success) {
    decision = "forwarded";
    forwardTxHash = broadcastResult.tx_hash;
    posture = "safe_to_broadcast";
  } else {
    decision = "held";
    reasonCodes.push("FORWARD_BROADCAST_FAILED");
    posture = "retry_forward";
  }

  // ── Write settlement record ─────────────────────────────────────

  const record: SettlementRecord = {
    settlement_id: settlementId,
    source_tx_hash: sourceTx.tx_hash,
    source_ledger_index: sourceTx.ledger_index,
    subscriber: sourceTx.account,
    service_id: serviceId,
    provider_address: providerAddress,
    gross_amount_drops: grossDrops,
    protocol_fee_drops: feeSplit.protocol_fee_drops,
    forward_amount_drops: feeSplit.forward_amount_drops,
    decision,
    reason_codes: reasonCodes,
    rejection_domain: null,
    forward_tx_hash: forwardTxHash,
    forward_memo_canonical: forwardMemoCanonical,
    idempotency_key: idempotencyKey,
    registry_snapshot_hash: registryHash,
    settled_at: now,
    router_version: ROUTER_VERSION,
  };

  writeSettlement(db, record);

  return {
    decision,
    reason_codes: reasonCodes,
    rejection_domain: null,
    source_tx_hash: sourceTx.tx_hash,
    source_ledger_index: sourceTx.ledger_index,
    subscriber: sourceTx.account,
    service_id: serviceId,
    registry_validation: validation,
    fee_split: feeSplit,
    forward_intent: forwardIntent,
    duplicate_guard: duplicateGuard,
    settlement_record: record,
    settlement_posture: posture,
    receipt: computeReceipt(record),
  };
}

// ─── Query Helpers ──────────────────────────────────────────────────

/** Protocol revenue for a time window */
export function getProtocolRevenue(
  db: Database.Database,
  sinceDays: number = 30,
): { totalFeeDrops: number; totalFeePft: number; settlementCount: number } {
  const row = db.prepare(`
    SELECT COALESCE(SUM(protocol_fee_drops), 0) as total, COUNT(*) as cnt
    FROM subs_settlements
    WHERE decision = 'forwarded' AND settled_at > datetime('now', ?)
  `).get(`-${sinceDays} days`) as { total: number; cnt: number };
  return {
    totalFeeDrops: row.total,
    totalFeePft: row.total / 1_000_000,
    settlementCount: row.cnt,
  };
}
