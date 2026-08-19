/**
 * subs-router.test.ts — Tests for the SUBS Payment Router Settlement Core
 *
 * 16 test cases:
 *   1.  Valid settlement: fee split, forward intent, settlement record, receipt
 *   2.  Fee rounding: floor exact on 500 PFT
 *   3.  Fee rounding: odd amount 333 PFT
 *   4.  Fee on tiny amount: 1 PFT
 *   5.  Dust rejection: 0 drops
 *   6.  SERVICE_NOT_FOUND rejection
 *   7.  SERVICE_RETIRED rejection
 *   8.  SERVICE_PAUSED rejection
 *   9.  INSUFFICIENT_PAYMENT rejection
 *  10.  WRONG_DESTINATION rejection
 *  11.  INVALID_MEMO_TYPE rejection
 *  12.  EMPTY_SERVICE_ID rejection
 *  13.  PROVIDER_ADDRESS_MISSING rejection
 *  14.  Duplicate source tx: returns duplicate without double-write
 *  15.  Forward broadcast failure: held + retry posture
 *  16.  Forward memo contains source tx linkage + all audit fields
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  routeSubscriptionPayment,
  ensureSettlementSchema,
  splitProtocolFee,
  getProtocolRevenue,
  type ServiceRegistry,
  type SourceTransaction,
} from "./subs-router.js";

// ─── Test Fixtures ──────────────────────────────────────────────────

const PROTOCOL_ADDR = "rSUBSprotocol123";
const TREASURY_ADDR = "rSUBStreasury123";
const PROVIDER_ADDR = "rProvider123";
const SUBSCRIBER = "rSubscriber123";

const REGISTRY: ServiceRegistry = {
  protocolAddress: PROTOCOL_ADDR,
  treasuryAddress: TREASURY_ADDR,
  feeRate: 0.025,
  services: [
    { serviceId: "alpha", name: "Alpha", providerAddress: PROVIDER_ADDR, priceDrops: 500_000_000, periodDays: 30, status: "active" },
    { serviceId: "retired-svc", name: "Old", providerAddress: PROVIDER_ADDR, priceDrops: 100_000_000, periodDays: 30, status: "retired" },
    { serviceId: "paused-svc", name: "Paused", providerAddress: PROVIDER_ADDR, priceDrops: 200_000_000, periodDays: 30, status: "paused" },
    { serviceId: "no-provider", name: "Broken", providerAddress: "", priceDrops: 100_000_000, periodDays: 30, status: "active" },
  ],
};

function createDb(): Database.Database {
  const db = new Database(":memory:");
  ensureSettlementSchema(db);
  return db;
}

function makeTx(overrides: Partial<SourceTransaction> = {}): SourceTransaction {
  return {
    tx_hash: overrides.tx_hash ?? `TX_${Math.random().toString(36).substring(2, 10)}`,
    ledger_index: overrides.ledger_index ?? 1850000,
    account: overrides.account ?? SUBSCRIBER,
    destination: overrides.destination ?? PROTOCOL_ADDR,
    amount_drops: overrides.amount_drops ?? "500000000",
    memo_type: overrides.memo_type ?? "subs.subscribe",
    memo_data: overrides.memo_data ?? "alpha",
    timestamp_iso: overrides.timestamp_iso ?? new Date().toISOString(),
  };
}

const BROADCAST_OK = { tx_hash: "FWD_123", success: true };
const BROADCAST_FAIL = { tx_hash: "", success: false };

// ─── Tests ──────────────────────────────────────────────────────────

describe("routeSubscriptionPayment", () => {
  let db: Database.Database;
  beforeEach(() => { db = createDb(); });
  afterEach(() => { db.close(); });

  // 1. Valid settlement
  it("produces forwarded decision with correct fee split, intent, record, receipt", () => {
    const tx = makeTx({ tx_hash: "TX_VALID" });
    const r = routeSubscriptionPayment(db, REGISTRY, tx, BROADCAST_OK);

    expect(r.decision).toBe("forwarded");
    expect(r.reason_codes).toHaveLength(0);
    expect(r.rejection_domain).toBeNull();
    expect(r.subscriber).toBe(SUBSCRIBER);
    expect(r.service_id).toBe("alpha");

    // Fee split
    expect(r.fee_split.gross_amount_drops).toBe(500_000_000);
    expect(r.fee_split.protocol_fee_drops).toBe(12_500_000);
    expect(r.fee_split.forward_amount_drops).toBe(487_500_000);
    expect(r.fee_split.fee_bps).toBe(250);
    expect(r.fee_split.rounding_policy).toBe("floor");

    // Forward intent
    expect(r.forward_intent).not.toBeNull();
    expect(r.forward_intent!.provider_destination).toBe(PROVIDER_ADDR);
    expect(r.forward_intent!.forward_amount_drops).toBe(487_500_000);
    expect(r.forward_intent!.memo.type).toBe("subs.forward");

    // Settlement record
    expect(r.settlement_record.settlement_id).toBe("STL-TX_VALID");
    expect(r.settlement_record.forward_tx_hash).toBe("FWD_123");
    expect(r.settlement_record.router_version).toBe("1.0.0");

    // Receipt
    expect(r.receipt.hash).toMatch(/^sha256:[a-f0-9]{64}$/);

    // Validation
    expect(r.registry_validation.status).toBe("passed");
    expect(r.registry_validation.evaluated_rules.length).toBeGreaterThanOrEqual(8);

    // Duplicate guard
    expect(r.duplicate_guard.duplicate).toBe(false);
    expect(r.duplicate_guard.replay_risk).toBe("low");

    // Posture
    expect(r.settlement_posture).toBe("safe_to_broadcast");
  });

  // 2. Fee rounding: 500 PFT exact
  it("computes exact floor fee on 500 PFT", () => {
    const fee = splitProtocolFee(500_000_000);
    expect(fee.protocol_fee_drops).toBe(12_500_000);
    expect(fee.forward_amount_drops).toBe(487_500_000);
    expect(fee.protocol_fee_drops + fee.forward_amount_drops).toBe(500_000_000);
  });

  // 3. Fee rounding: 333 PFT
  it("applies floor rounding on odd amount (333 PFT)", () => {
    const fee = splitProtocolFee(333_000_000);
    expect(fee.protocol_fee_drops).toBe(8_325_000);
    expect(fee.forward_amount_drops).toBe(324_675_000);
    expect(fee.protocol_fee_drops + fee.forward_amount_drops).toBe(333_000_000);
  });

  // 4. Fee on tiny amount: 1 PFT
  it("computes correct fee on 1 PFT (25000 drops)", () => {
    const fee = splitProtocolFee(1_000_000);
    expect(fee.protocol_fee_drops).toBe(25_000);
    expect(fee.forward_amount_drops).toBe(975_000);
    expect(fee.protocol_fee_drops + fee.forward_amount_drops).toBe(1_000_000);
  });

  // 5. Dust rejection: 0 drops
  it("rejects dust amount (0 drops) with DUST_AMOUNT", () => {
    const tx = makeTx({ amount_drops: "0" });
    const r = routeSubscriptionPayment(db, REGISTRY, tx);

    expect(r.decision).toBe("rejected");
    expect(r.reason_codes).toContain("DUST_AMOUNT");
    expect(r.rejection_domain).toBe("payment_shape");
    expect(r.settlement_posture).toBe("reject_do_not_retry");
  });

  // 6. SERVICE_NOT_FOUND
  it("rejects unknown service with SERVICE_NOT_FOUND", () => {
    const tx = makeTx({ memo_data: "nonexistent" });
    const r = routeSubscriptionPayment(db, REGISTRY, tx);

    expect(r.decision).toBe("rejected");
    expect(r.reason_codes).toContain("SERVICE_NOT_FOUND");
    expect(r.rejection_domain).toBe("registry");
    expect(r.forward_intent).toBeNull();
  });

  // 7. SERVICE_RETIRED
  it("rejects retired service with SERVICE_RETIRED", () => {
    const tx = makeTx({ memo_data: "retired-svc", amount_drops: "100000000" });
    const r = routeSubscriptionPayment(db, REGISTRY, tx);

    expect(r.decision).toBe("rejected");
    expect(r.reason_codes).toContain("SERVICE_RETIRED");
  });

  // 8. SERVICE_PAUSED
  it("rejects paused service with SERVICE_PAUSED", () => {
    const tx = makeTx({ memo_data: "paused-svc", amount_drops: "200000000" });
    const r = routeSubscriptionPayment(db, REGISTRY, tx);

    expect(r.decision).toBe("rejected");
    expect(r.reason_codes).toContain("SERVICE_PAUSED");
  });

  // 9. INSUFFICIENT_PAYMENT
  it("rejects insufficient payment amount", () => {
    const tx = makeTx({ amount_drops: "100000000" }); // 100 PFT < 500 PFT
    const r = routeSubscriptionPayment(db, REGISTRY, tx);

    expect(r.decision).toBe("rejected");
    expect(r.reason_codes).toContain("INSUFFICIENT_PAYMENT");
    expect(r.rejection_domain).toBe("payment_shape");
  });

  // 10. WRONG_DESTINATION
  it("rejects payment to wrong destination", () => {
    const tx = makeTx({ destination: "rWrongAddr123" });
    const r = routeSubscriptionPayment(db, REGISTRY, tx);

    expect(r.decision).toBe("rejected");
    expect(r.reason_codes).toContain("WRONG_DESTINATION");
  });

  // 11. INVALID_MEMO_TYPE
  it("rejects wrong memo type", () => {
    const tx = makeTx({ memo_type: "pf.ptr" });
    const r = routeSubscriptionPayment(db, REGISTRY, tx);

    expect(r.decision).toBe("rejected");
    expect(r.reason_codes).toContain("INVALID_MEMO_TYPE");
  });

  // 12. EMPTY_SERVICE_ID
  it("rejects empty service ID in memo data", () => {
    const tx = makeTx({ memo_data: "" });
    const r = routeSubscriptionPayment(db, REGISTRY, tx);

    expect(r.decision).toBe("rejected");
    expect(r.reason_codes).toContain("EMPTY_SERVICE_ID");
  });

  // 13. PROVIDER_ADDRESS_MISSING
  it("rejects service with missing provider address", () => {
    const tx = makeTx({ memo_data: "no-provider", amount_drops: "100000000" });
    const r = routeSubscriptionPayment(db, REGISTRY, tx);

    expect(r.decision).toBe("rejected");
    expect(r.reason_codes).toContain("PROVIDER_ADDRESS_MISSING");
  });

  // 14. Duplicate: no double-write
  it("returns duplicate without writing twice for same source tx", () => {
    const tx = makeTx({ tx_hash: "TX_DUPE" });

    const first = routeSubscriptionPayment(db, REGISTRY, tx, BROADCAST_OK);
    expect(first.decision).toBe("forwarded");

    const second = routeSubscriptionPayment(db, REGISTRY, tx, BROADCAST_OK);
    expect(second.decision).toBe("duplicate");
    expect(second.reason_codes).toContain("DUPLICATE_SOURCE_TX");
    expect(second.duplicate_guard.duplicate).toBe(true);
    expect(second.duplicate_guard.branch).toBe("DUPLICATE_SOURCE_TX");
    expect(second.duplicate_guard.replay_risk).toBe("blocked");
    expect(second.settlement_posture).toBe("reject_do_not_retry");

    const count = (db.prepare(
      "SELECT COUNT(*) as c FROM subs_settlements WHERE source_tx_hash = 'TX_DUPE'"
    ).get() as { c: number }).c;
    expect(count).toBe(1);
  });

  // 15. Forward broadcast failure
  it("holds with retry posture when broadcast fails", () => {
    const tx = makeTx({ tx_hash: "TX_FWD_FAIL" });
    const r = routeSubscriptionPayment(db, REGISTRY, tx, BROADCAST_FAIL);

    expect(r.decision).toBe("held");
    expect(r.reason_codes).toContain("FORWARD_BROADCAST_FAILED");
    expect(r.settlement_posture).toBe("retry_forward");
    expect(r.settlement_record.forward_tx_hash).toBeNull();
    // Fee still computed correctly
    expect(r.fee_split.protocol_fee_drops).toBe(12_500_000);
    // Record IS written for retry
    const row = db.prepare("SELECT * FROM subs_settlements WHERE source_tx_hash = 'TX_FWD_FAIL'").get();
    expect(row).toBeTruthy();
  });

  // 16. Forward memo contains source tx linkage + audit fields
  it("builds forward memo with full audit payload linked to source tx", () => {
    const tx = makeTx({ tx_hash: "TX_MEMO_CHECK", ledger_index: 1850042 });
    const r = routeSubscriptionPayment(db, REGISTRY, tx, BROADCAST_OK);

    const memo = r.forward_intent!.memo;
    expect(memo.type).toBe("subs.forward");
    expect(memo.data.source_tx_hash).toBe("TX_MEMO_CHECK");
    expect(memo.data.source_ledger_index).toBe(1850042);
    expect(memo.data.service_id).toBe("alpha");
    expect(memo.data.subscriber).toBe(SUBSCRIBER);
    expect(memo.data.provider).toBe(PROVIDER_ADDR);
    expect(memo.data.gross_amount_drops).toBe(500_000_000);
    expect(memo.data.protocol_fee_drops).toBe(12_500_000);
    expect(memo.data.forward_amount_drops).toBe(487_500_000);
    expect(memo.data.router_version).toBe("1.0.0");
    expect(memo.data.settlement_id).toBe("STL-TX_MEMO_CHECK");
    // Canonical form is valid JSON
    expect(() => JSON.parse(memo.data_canonical)).not.toThrow();
  });
});

describe("routeSubscriptionPayment: revenue query", () => {
  let db: Database.Database;
  beforeEach(() => { db = createDb(); });
  afterEach(() => { db.close(); });

  it("tracks protocol revenue across settlements", () => {
    routeSubscriptionPayment(db, REGISTRY, makeTx({ tx_hash: "TX_R1" }), BROADCAST_OK);
    routeSubscriptionPayment(db, REGISTRY, makeTx({ tx_hash: "TX_R2", amount_drops: "1000000000" }), BROADCAST_OK);

    const rev = getProtocolRevenue(db, 30);
    expect(rev.settlementCount).toBe(2);
    expect(rev.totalFeeDrops).toBe(12_500_000 + 25_000_000);
    expect(rev.totalFeePft).toBe(37.5);
  });
});
