/**
 * subs-verify.test.ts — Tests for the SUBS Entitlement Verifier
 *
 * 12 test cases covering:
 *   1. No payment → inactive + NO_QUALIFYING_PAYMENT
 *   2. Valid payment within period → active + PAYMENT_VALID
 *   3. Payment expired → expired + PAYMENT_EXPIRED
 *   4. Payment in grace period → expiring + PAYMENT_VALID_GRACE_PERIOD
 *   5. Insufficient payment amount → inactive + PAYMENT_INSUFFICIENT
 *   6. Wrong service_id in memo → inactive + NO_QUALIFYING_PAYMENT
 *   7. Wrong memo_type → inactive + NO_QUALIFYING_PAYMENT
 *   8. Lifetime stats accumulate across multiple payments
 *   9. Most recent payment wins (renewal resets period)
 *  10. getActiveSubscribers returns only active addresses
 *  11. Freshness disclosure when crawl_state is available
 *  12. Freshness disclosure when crawl_state is missing
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  checkEntitlement,
  getActiveSubscribers,
  type SubsServiceConfig,
  type SubsEntitlementResult,
} from "./subs-verify.js";

// ─── Test Helpers ───────────────────────────────────────────────────

const PROTOCOL_ADDR = "rSUBSprotocolAddress123456";
const SERVICE_ADDR = "rServiceProvider123456789";
const SUBSCRIBER = "rSubscriber123456789ABCD";
const SUBSCRIBER_2 = "rSubscriber2ABCDEF12345";

const DEFAULT_CONFIG: SubsServiceConfig = {
  subsProtocolAddress: PROTOCOL_ADDR,
  serviceId: "alpha",
  pricePft: 500,
  periodDays: 30,
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

    CREATE TABLE crawl_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

function insertSubscription(
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
    isoTimestamp?: string;
  } = {},
): void {
  const {
    txHash = `TX_${Math.random().toString(36).substring(2, 10)}`,
    subscriber: account = SUBSCRIBER,
    destination = PROTOCOL_ADDR,
    amountPft = 500,
    serviceId = "alpha",
    memoType = "subs.subscribe",
    txType = "Payment",
    daysAgo = 5,
    isoTimestamp,
  } = opts;

  const ts = isoTimestamp ?? new Date(Date.now() - daysAgo * 86400000).toISOString();
  const drops = String(amountPft * 1_000_000);

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

describe("subs-verify: checkEntitlement", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // Test 1: No payment at all
  it("returns inactive with NO_QUALIFYING_PAYMENT when no payment exists", () => {
    const result = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);

    expect(result.entitled).toBe(false);
    expect(result.state).toBe("inactive");
    expect(result.reason).toBe("NO_QUALIFYING_PAYMENT");
    expect(result.subscriber).toBe(SUBSCRIBER);
    expect(result.serviceId).toBe("alpha");
    expect(result.currentPeriod).toBeNull();
    expect(result.lifetime.totalPayments).toBe(0);
    expect(result.lifetime.totalPaidPft).toBe(0);
    expect(result.lifetime.firstSubscribedAt).toBeNull();
  });

  // Test 2: Valid payment within period
  it("returns active with PAYMENT_VALID for a qualifying payment within period", () => {
    insertSubscription(db, { txHash: "TX_VALID", daysAgo: 5 });
    setCrawlState(db, 10);

    const result = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);

    expect(result.entitled).toBe(true);
    expect(result.state).toBe("active");
    expect(result.reason).toBe("PAYMENT_VALID");
    expect(result.currentPeriod).not.toBeNull();
    expect(result.currentPeriod!.paymentTx).toBe("TX_VALID");
    expect(result.currentPeriod!.amountPft).toBe(500);
    expect(result.lifetime.totalPayments).toBe(1);
    expect(result.lifetime.totalPaidPft).toBe(500);
  });

  // Test 3: Payment expired
  it("returns expired with PAYMENT_EXPIRED when payment is outside period", () => {
    insertSubscription(db, { txHash: "TX_OLD", daysAgo: 35 });

    const result = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);

    expect(result.entitled).toBe(false);
    expect(result.state).toBe("expired");
    expect(result.reason).toBe("PAYMENT_EXPIRED");
    expect(result.currentPeriod).not.toBeNull();
    expect(result.currentPeriod!.paymentTx).toBe("TX_OLD");
    expect(result.lifetime.totalPayments).toBe(1);
  });

  // Test 4: Payment in grace period (72h before expiry)
  it("returns expiring with PAYMENT_VALID_GRACE_PERIOD near expiry", () => {
    // Payment 28.5 days ago → expires in 1.5 days → within 72h grace
    insertSubscription(db, { txHash: "TX_GRACE", daysAgo: 28.5 });

    const result = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);

    expect(result.entitled).toBe(true);
    expect(result.state).toBe("expiring");
    expect(result.reason).toBe("PAYMENT_VALID_GRACE_PERIOD");
    expect(result.currentPeriod!.paymentTx).toBe("TX_GRACE");
  });

  // Test 5: Insufficient payment amount
  it("returns inactive with PAYMENT_INSUFFICIENT when amount is too low", () => {
    insertSubscription(db, { txHash: "TX_CHEAP", amountPft: 100 });

    const result = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);

    expect(result.entitled).toBe(false);
    expect(result.state).toBe("inactive");
    expect(result.reason).toBe("PAYMENT_INSUFFICIENT");
  });

  // Test 6: Wrong service_id in memo
  it("returns inactive when memo_data contains wrong service_id", () => {
    insertSubscription(db, { txHash: "TX_WRONG_SVC", serviceId: "beta" });

    const result = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);

    expect(result.entitled).toBe(false);
    expect(result.state).toBe("inactive");
    expect(result.reason).toBe("NO_QUALIFYING_PAYMENT");
  });

  // Test 7: Wrong memo_type
  it("returns inactive when memo_type is not subs.subscribe", () => {
    insertSubscription(db, { txHash: "TX_WRONG_TYPE", memoType: "pf.ptr" });

    const result = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);

    expect(result.entitled).toBe(false);
    expect(result.state).toBe("inactive");
    expect(result.reason).toBe("NO_QUALIFYING_PAYMENT");
  });

  // Test 8: Lifetime stats accumulate
  it("accumulates lifetime stats across multiple payments", () => {
    insertSubscription(db, { txHash: "TX_1", daysAgo: 60, amountPft: 500 });
    insertSubscription(db, { txHash: "TX_2", daysAgo: 25, amountPft: 500 });
    insertSubscription(db, { txHash: "TX_3", daysAgo: 2, amountPft: 600 });

    const result = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);

    expect(result.entitled).toBe(true);
    expect(result.lifetime.totalPayments).toBe(3);
    expect(result.lifetime.totalPaidPft).toBe(1600);
    expect(result.lifetime.firstSubscribedAt).not.toBeNull();
  });

  // Test 9: Most recent payment wins (renewal)
  it("uses most recent qualifying payment for period calculation", () => {
    insertSubscription(db, { txHash: "TX_OLD_PERIOD", daysAgo: 20 });
    insertSubscription(db, { txHash: "TX_RENEWAL", daysAgo: 2 });

    const result = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);

    expect(result.entitled).toBe(true);
    expect(result.state).toBe("active");
    expect(result.currentPeriod!.paymentTx).toBe("TX_RENEWAL");
  });

  // Test 10: Overpayment still grants only one period (no extension)
  it("grants one period for overpayment without extension", () => {
    insertSubscription(db, { txHash: "TX_OVERPAY", amountPft: 1500, daysAgo: 5 });

    const result = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);

    expect(result.entitled).toBe(true);
    expect(result.currentPeriod!.amountPft).toBe(1500);
    // Period is still 30 days, not 90
    const start = new Date(result.currentPeriod!.startedAt);
    const end = new Date(result.currentPeriod!.expiresAt);
    const periodMs = end.getTime() - start.getTime();
    const periodDays = periodMs / (86400 * 1000);
    expect(periodDays).toBe(30);
  });
});

describe("subs-verify: getActiveSubscribers", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // Test 11: Returns only active subscribers
  it("returns only subscribers with qualifying payments within period", () => {
    // Active subscriber
    insertSubscription(db, { subscriber: SUBSCRIBER, daysAgo: 5 });
    // Expired subscriber
    insertSubscription(db, { subscriber: SUBSCRIBER_2, daysAgo: 35 });

    const active = getActiveSubscribers(db, DEFAULT_CONFIG);

    expect(active).toContain(SUBSCRIBER);
    expect(active).not.toContain(SUBSCRIBER_2);
    expect(active.length).toBe(1);
  });
});

describe("subs-verify: freshness disclosure", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // Test 12: Freshness with crawl_state available
  it("reports freshness when crawl_state exists and is recent", () => {
    setCrawlState(db, 5); // 5 minutes ago

    const result = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);

    expect(result.freshness.indexedAt).not.toBeNull();
    expect(result.freshness.stale).toBe(false);
    expect(result.freshness.stalenessSeconds).toBeGreaterThanOrEqual(0);
    expect(result.freshness.note).toContain("within freshness window");
  });

  // Test 13: Freshness when crawl_state is stale
  it("flags staleness when index is older than threshold", () => {
    setCrawlState(db, 120); // 2 hours ago

    const result = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);

    expect(result.freshness.stale).toBe(true);
    expect(result.freshness.note).toContain("STALE");
  });

  // Test 14: Freshness when crawl_state is missing
  it("handles missing crawl_state gracefully", () => {
    db.exec("DELETE FROM crawl_state");

    const result = checkEntitlement(db, DEFAULT_CONFIG, SUBSCRIBER);

    expect(result.freshness.indexedAt).toBeNull();
    expect(result.freshness.stale).toBe(true);
    expect(result.freshness.note).toContain("not available");
  });
});
