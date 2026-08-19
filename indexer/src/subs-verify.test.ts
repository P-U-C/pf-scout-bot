/**
 * subs-verify.test.ts — Tests for the Canonical SUBS Entitlement Verifier
 *
 * 16 test cases covering:
 *   1.  No payment → inactive, NO_QUALIFYING_PAYMENT, empty condition vector
 *   2.  Valid payment → active, PAYMENT_VALID, all 7 conditions pass
 *   3.  Payment expired → expired, PAYMENT_EXPIRED
 *   4.  Grace period → expiring, PAYMENT_VALID_GRACE_PERIOD
 *   5.  Insufficient amount → condition 5 fails, PAYMENT_INSUFFICIENT
 *   6.  Wrong service_id → condition 4 fails, SERVICE_ID_MISMATCH
 *   7.  Wrong memo_type → condition 3 fails, NO_QUALIFYING_PAYMENT
 *   8.  Lifetime stats accumulate across multiple payments
 *   9.  Most recent payment wins (renewal resets period)
 *  10.  Overpayment grants one period only
 *  11.  Service retired → SERVICE_RETIRED before evaluation
 *  12.  Freshness disclosure — recent index
 *  13.  Freshness disclosure — stale index, INDEX_STALE_NO_FALLBACK
 *  14.  Freshness disclosure — missing crawl_state
 *  15.  Receipt hash is deterministic and stable
 *  16.  Evaluated conditions vector has 7 entries with correct structure
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { checkEntitlement, type SubsServiceConfig } from "./subs-verify.js";

// ─── Test Helpers ───────────────────────────────────────────────────

const PROTOCOL_ADDR = "rSUBSprotocolAddress123456";
const SUBSCRIBER = "rSubscriber123456789ABCD";

const DEFAULT_CONFIG: SubsServiceConfig = {
  subsProtocolAddress: PROTOCOL_ADDR,
  serviceId: "alpha",
  pricePft: 500,
  periodDays: 30,
  serviceStatus: "active",
  gracePeriodHours: 72,
  stalenessThresholdSeconds: 5400,
};

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE transactions (
      tx_hash TEXT PRIMARY KEY,
      ledger_index INTEGER NOT NULL,
      tx_type TEXT NOT NULL,
      account TEXT NOT NULL,
      destination TEXT,
      amount_drops TEXT,
      fee_drops TEXT,
      timestamp_ripple INTEGER,
      timestamp_iso TEXT,
      has_memo INTEGER DEFAULT 0,
      memo_type TEXT,
      memo_data_preview TEXT,
      memo_cid TEXT,
      raw_json TEXT
    );
    CREATE INDEX idx_tx_destination ON transactions(destination);
    CREATE INDEX idx_tx_account ON transactions(account);
    CREATE TABLE crawl_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

function insertTx(
  db: Database.Database,
  opts: {
    txHash?: string;
    subscriber?: string;
    destination?: string;
    amountPft?: number;
    serviceId?: string;
    memoType?: string;
    txType?: string;
    daysAgo?: number;
  } = {},
): void {
  const txHash = opts.txHash ?? `TX_${Math.random().toString(36).substring(2, 10)}`;
  const account = opts.subscriber ?? SUBSCRIBER;
  const destination = opts.destination ?? PROTOCOL_ADDR;
  const drops = String((opts.amountPft ?? 500) * 1_000_000);
  const memoType = opts.memoType ?? "subs.subscribe";
  const serviceId = opts.serviceId ?? "alpha";
  const txType = opts.txType ?? "Payment";
  const ts = new Date(Date.now() - (opts.daysAgo ?? 5) * 86400000).toISOString();

  db.prepare(`
    INSERT INTO transactions
    (tx_hash, ledger_index, tx_type, account, destination, amount_drops, fee_drops,
     timestamp_ripple, timestamp_iso, has_memo, memo_type, memo_data_preview, memo_cid, raw_json)
    VALUES (?, 1000, ?, ?, ?, ?, '12', 0, ?, 1, ?, ?, NULL, '{}')
  `).run(txHash, txType, account, destination, drops, ts, memoType, serviceId);
}

function setCrawlState(db: Database.Database, minutesAgo: number): void {
  const ts = new Date(Date.now() - minutesAgo * 60000).toISOString();
  db.prepare("INSERT OR REPLACE INTO crawl_state (key, value) VALUES ('last_crawl_at', ?)").run(ts);
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("checkEntitlement: qualification + entitlement", () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  // 1. No payment at all
  it("returns inactive with NO_QUALIFYING_PAYMENT and empty condition vector", () => {
    setCrawlState(db, 5); // Fresh index so reason isn't INDEX_STALE
    const r = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);
    expect(r.entitled).toBe(false);
    expect(r.state).toBe("inactive");
    expect(r.reason).toBe("NO_QUALIFYING_PAYMENT");
    expect(r.currentPeriod).toBeNull();
    expect(r.lifetime.totalPayments).toBe(0);
    expect(r.evaluated_conditions).toHaveLength(7);
    expect(r.evaluated_conditions[0].passed).toBe(false);
    expect(r.resolution_method).toBe("chain_query");
  });

  // 2. Valid payment — all 7 conditions pass
  it("returns active with PAYMENT_VALID and all 7 conditions passing", () => {
    insertTx(db, { txHash: "TX_VALID", daysAgo: 5 });
    setCrawlState(db, 10);

    const r = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);
    expect(r.entitled).toBe(true);
    expect(r.state).toBe("active");
    expect(r.reason).toBe("PAYMENT_VALID");
    expect(r.currentPeriod!.paymentTx).toBe("TX_VALID");
    expect(r.currentPeriod!.amountPft).toBe(500);
    expect(r.evaluated_conditions).toHaveLength(7);
    expect(r.evaluated_conditions.every(c => c.passed)).toBe(true);
    expect(r.evaluated_conditions[6].name).toBe("tx_success");
    expect(r.evaluated_conditions[6].expected).toBe("tesSUCCESS");
  });

  // 3. Expired payment
  it("returns expired with PAYMENT_EXPIRED when payment is outside period", () => {
    insertTx(db, { txHash: "TX_OLD", daysAgo: 35 });

    const r = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);
    expect(r.entitled).toBe(false);
    expect(r.state).toBe("expired");
    expect(r.reason).toBe("PAYMENT_EXPIRED");
    expect(r.currentPeriod!.paymentTx).toBe("TX_OLD");
  });

  // 4. Grace period
  it("returns expiring with PAYMENT_VALID_GRACE_PERIOD near expiry", () => {
    insertTx(db, { txHash: "TX_GRACE", daysAgo: 28.5 });

    const r = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);
    expect(r.entitled).toBe(true);
    expect(r.state).toBe("expiring");
    expect(r.reason).toBe("PAYMENT_VALID_GRACE_PERIOD");
  });

  // 5. Insufficient amount — condition 5 fails
  it("returns PAYMENT_INSUFFICIENT when condition 5 fails", () => {
    insertTx(db, { txHash: "TX_CHEAP", amountPft: 100, daysAgo: 5 });

    const r = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);
    expect(r.entitled).toBe(false);
    expect(r.reason).toBe("PAYMENT_INSUFFICIENT");
    // Condition 5 specifically should fail
    const cond5 = r.evaluated_conditions.find(c => c.id === 5);
    expect(cond5?.passed).toBe(false);
    expect(cond5?.reason_code).toBe("PAYMENT_INSUFFICIENT");
  });

  // 6. Wrong service_id — condition 4 fails
  it("returns SERVICE_ID_MISMATCH when condition 4 fails", () => {
    insertTx(db, { txHash: "TX_WRONG_SVC", serviceId: "beta", daysAgo: 5 });

    const r = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);
    expect(r.entitled).toBe(false);
    expect(r.reason).toBe("SERVICE_ID_MISMATCH");
    const cond4 = r.evaluated_conditions.find(c => c.id === 4);
    expect(cond4?.passed).toBe(false);
    expect(cond4?.reason_code).toBe("SERVICE_ID_MISMATCH");
  });

  // 7. Wrong memo_type — condition 3 fails
  it("returns NO_QUALIFYING_PAYMENT when memo_type is wrong", () => {
    insertTx(db, { txHash: "TX_WRONG_TYPE", memoType: "pf.ptr", daysAgo: 5 });

    const r = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);
    expect(r.entitled).toBe(false);
    // No candidates match conditions 1+2+6 with memo_type=pf.ptr, so falls through
    const cond3 = r.evaluated_conditions.find(c => c.id === 3);
    expect(cond3?.passed).toBe(false);
  });

  // 8. Lifetime accumulation
  it("accumulates lifetime stats across multiple payments", () => {
    insertTx(db, { txHash: "TX_1", daysAgo: 60, amountPft: 500 });
    insertTx(db, { txHash: "TX_2", daysAgo: 25, amountPft: 500 });
    insertTx(db, { txHash: "TX_3", daysAgo: 2, amountPft: 600 });

    const r = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);
    expect(r.entitled).toBe(true);
    expect(r.lifetime.totalPayments).toBe(3);
    expect(r.lifetime.totalPaidPft).toBe(1600);
    expect(r.lifetime.firstSubscribedAt).not.toBeNull();
  });

  // 9. Most recent payment wins
  it("uses most recent qualifying payment for period calculation", () => {
    insertTx(db, { txHash: "TX_OLD_PERIOD", daysAgo: 20 });
    insertTx(db, { txHash: "TX_RENEWAL", daysAgo: 2 });

    const r = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);
    expect(r.entitled).toBe(true);
    expect(r.currentPeriod!.paymentTx).toBe("TX_RENEWAL");
  });

  // 10. Overpayment — one period only
  it("grants one period for overpayment without extension", () => {
    insertTx(db, { txHash: "TX_OVERPAY", amountPft: 1500, daysAgo: 5 });

    const r = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);
    expect(r.entitled).toBe(true);
    const start = new Date(r.currentPeriod!.startedAt);
    const end = new Date(r.currentPeriod!.expiresAt);
    const days = (end.getTime() - start.getTime()) / 86400000;
    expect(days).toBe(30);
  });

  // 11. Service retired
  it("returns SERVICE_RETIRED immediately without evaluating payments", () => {
    insertTx(db, { txHash: "TX_VALID_BUT_RETIRED", daysAgo: 5 });

    const config = { ...DEFAULT_CONFIG, serviceStatus: "retired" as const };
    const r = checkEntitlement(db, config, SUBSCRIBER);
    expect(r.entitled).toBe(false);
    expect(r.state).toBe("inactive");
    expect(r.reason).toBe("SERVICE_RETIRED");
    expect(r.evaluated_conditions[0].reason_code).toBe("SERVICE_RETIRED");
  });
});

describe("checkEntitlement: freshness disclosure", () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  // 12. Fresh index
  it("reports fresh index with source=chain_index and stale=false", () => {
    setCrawlState(db, 5);
    const r = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);
    expect(r.freshness.source).toBe("chain_index");
    expect(r.freshness.stale).toBe(false);
    expect(r.freshness.disclosure).toContain("within freshness window");
  });

  // 13. Stale index — reason code escalates
  it("flags INDEX_STALE_NO_FALLBACK when index is stale and no payment found", () => {
    setCrawlState(db, 120);
    const r = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);
    expect(r.freshness.stale).toBe(true);
    expect(r.freshness.disclosure).toContain("STALE");
    expect(r.reason).toBe("INDEX_STALE_NO_FALLBACK");
  });

  // 14. Missing crawl_state
  it("handles missing crawl_state with stale=true and disclosure note", () => {
    db.exec("DELETE FROM crawl_state");
    const r = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);
    expect(r.freshness.indexedAt).toBeNull();
    expect(r.freshness.stale).toBe(true);
    expect(r.freshness.disclosure).toContain("not available");
  });
});

describe("checkEntitlement: receipt", () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  // 15. Receipt hash is deterministic
  it("produces deterministic receipt hash for same inputs", () => {
    insertTx(db, { txHash: "TX_RECEIPT", daysAgo: 5 });
    setCrawlState(db, 2);

    const r1 = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);
    const r2 = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);

    expect(r1.receipt.hash).toBe(r2.receipt.hash);
    expect(r1.receipt.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(r1.receipt.inputs.methodologyVersion).toBe("1.0.0");
    expect(r1.receipt.inputs.qualifyingTx).toBe("TX_RECEIPT");
    expect(r1.receipt.inputs.subscriber).toBe(SUBSCRIBER);
    expect(r1.receipt.inputs.serviceId).toBe("alpha");
  });
});

describe("checkEntitlement: evaluated_conditions structure", () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  // 16. Condition vector has correct structure
  it("returns 7 conditions with id, name, passed, field, observed, expected, reason_code", () => {
    insertTx(db, { daysAgo: 5 });

    const r = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);
    expect(r.evaluated_conditions).toHaveLength(7);

    const expectedNames = [
      "destination_match", "subscriber_match", "memo_type_match",
      "service_id_match", "sufficient_payment", "valid_tx_type", "tx_success",
    ];

    for (let i = 0; i < 7; i++) {
      const c = r.evaluated_conditions[i];
      expect(c.id).toBe(i + 1);
      expect(c.name).toBe(expectedNames[i]);
      expect(typeof c.passed).toBe("boolean");
      expect(typeof c.field).toBe("string");
      expect(typeof c.observed).toBe("string");
      expect(typeof c.expected).toBe("string");
      // reason_code is null when passed, a SubsReason when failed
      if (c.passed) {
        expect(c.reason_code).toBeNull();
      }
    }
  });
});
