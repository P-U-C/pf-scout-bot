/**
 * subs-verify.ts — Canonical SUBS Entitlement Verifier Module
 *
 * Resolves subscription entitlement from public chain-indexed subscription
 * records using the canonical 7-condition evaluation from the SUBS protocol spec.
 *
 * Returns deterministic status, reason codes, freshness, and staleness disclosure.
 * Designed so the router bot, marketplace page, and premium services can all
 * consume the same contract without re-implementing payment logic.
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
 *     gracePeriodHours: 72,
 *   }, "rSubscriber123...")
 *
 * Output (active subscription):
 *   {
 *     entitled: true,
 *     state: "active",
 *     reason: "PAYMENT_VALID",
 *     subscriber: "rSubscriber123...",
 *     serviceId: "alpha",
 *     currentPeriod: {
 *       startedAt: "2026-04-13T10:00:00.000Z",
 *       expiresAt: "2026-05-13T10:00:00.000Z",
 *       paymentTx: "AAA111...",
 *       amountPft: 500,
 *     },
 *     lifetime: {
 *       firstSubscribedAt: "2026-04-13T10:00:00.000Z",
 *       totalPayments: 1,
 *       totalPaidPft: 500,
 *     },
 *     freshness: {
 *       resolvedAt: "2026-04-13T10:05:00.000Z",
 *       indexedAt: "2026-04-13T10:00:02.000Z",
 *       stalenessSeconds: 298,
 *       stale: false,
 *       note: "Index as of 2026-04-13T10:00:02.000Z (5m ago, within freshness window)",
 *     },
 *   }
 *
 * Output (no subscription):
 *   {
 *     entitled: false,
 *     state: "inactive",
 *     reason: "NO_QUALIFYING_PAYMENT",
 *     subscriber: "rSubscriber123...",
 *     serviceId: "alpha",
 *     currentPeriod: null,
 *     lifetime: { firstSubscribedAt: null, totalPayments: 0, totalPaidPft: 0 },
 *     freshness: { ... },
 *   }
 */

import type Database from "better-sqlite3";

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
  | "SERVICE_ID_MISMATCH";

export interface SubsPeriod {
  /** ISO timestamp when the current period started (payment time) */
  startedAt: string;
  /** ISO timestamp when the current period expires */
  expiresAt: string;
  /** Transaction hash of the qualifying payment */
  paymentTx: string;
  /** Amount paid in PFT */
  amountPft: number;
}

export interface SubsLifetime {
  /** ISO timestamp of the first-ever qualifying payment, or null */
  firstSubscribedAt: string | null;
  /** Total number of qualifying payments */
  totalPayments: number;
  /** Total PFT paid across all payments */
  totalPaidPft: number;
}

export interface SubsFreshness {
  /** ISO timestamp when this resolution was computed */
  resolvedAt: string;
  /** ISO timestamp of the last indexer crawl */
  indexedAt: string | null;
  /** Seconds since last index update */
  stalenessSeconds: number;
  /** True if index is older than the staleness threshold */
  stale: boolean;
  /** Human-readable freshness disclosure */
  note: string;
}

export interface SubsEntitlementResult {
  /** Whether the subscriber is currently entitled to access */
  entitled: boolean;
  /** Current subscription state */
  state: SubsState;
  /** Deterministic reason code explaining the result */
  reason: SubsReason;
  /** Subscriber address that was checked */
  subscriber: string;
  /** Service ID that was checked */
  serviceId: string;
  /** Current billing period details, or null if inactive */
  currentPeriod: SubsPeriod | null;
  /** Lifetime subscription statistics */
  lifetime: SubsLifetime;
  /** Freshness and staleness disclosure */
  freshness: SubsFreshness;
}

// ─── Core Entitlement Check ─────────────────────────────────────────

/**
 * Resolve subscription entitlement using the canonical 7-condition evaluation.
 *
 * The seven conditions (all must be met for a qualifying payment):
 *   1. destination = subsProtocolAddress
 *   2. account = subscriber
 *   3. memo_type = "subs.subscribe"
 *   4. memo_data contains serviceId
 *   5. amount_drops >= pricePft * 1,000,000
 *   6. tx_type = "Payment"
 *   7. Transaction within billing period (timestamp_iso > now - periodDays)
 *
 * @param db - better-sqlite3 database instance (chain-index.db)
 * @param config - Service configuration (protocol address, service ID, price, period)
 * @param subscriber - XRPL address of the subscriber to check
 * @returns Deterministic entitlement result with freshness disclosure
 */
export function checkEntitlement(
  db: Database.Database,
  config: SubsServiceConfig,
  subscriber: string,
): SubsEntitlementResult {
  const now = new Date();
  const resolvedAt = now.toISOString();
  const minDrops = config.pricePft * 1_000_000;
  const periodClause = `-${config.periodDays} days`;
  const gracePeriodHours = config.gracePeriodHours ?? 72;
  const stalenessThreshold = config.stalenessThresholdSeconds ?? 5400;

  // ── Freshness: when was the index last updated? ─────────────────

  const freshness = computeFreshness(db, now, stalenessThreshold);

  // ── Condition 7 first: find most recent qualifying payment within period ──

  const activePeriodPayment = db.prepare(`
    SELECT tx_hash, timestamp_iso, CAST(amount_drops AS INTEGER) as amount_drops,
           memo_data_preview
    FROM transactions
    WHERE destination = ?
      AND account = ?
      AND memo_type = 'subs.subscribe'
      AND memo_data_preview LIKE '%' || ? || '%'
      AND CAST(amount_drops AS INTEGER) >= ?
      AND tx_type = 'Payment'
      AND timestamp_iso > datetime('now', ?)
    ORDER BY timestamp_iso DESC
    LIMIT 1
  `).get(
    config.subsProtocolAddress,
    subscriber,
    config.serviceId,
    minDrops,
    periodClause,
  ) as { tx_hash: string; timestamp_iso: string; amount_drops: number; memo_data_preview: string } | undefined;

  // ── Lifetime stats (all-time, regardless of period) ─────────────

  const lifetime = computeLifetime(db, config, subscriber);

  // ── No qualifying payment in period ─────────────────────────────

  if (!activePeriodPayment) {
    // Check if there was ever a qualifying payment (to distinguish inactive vs expired)
    const latestEver = db.prepare(`
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

    if (!latestEver) {
      // Check if there were any payments at all (maybe insufficient amount)
      const anyPayment = db.prepare(`
        SELECT CAST(amount_drops AS INTEGER) as amount_drops
        FROM transactions
        WHERE destination = ?
          AND account = ?
          AND memo_type = 'subs.subscribe'
          AND memo_data_preview LIKE '%' || ? || '%'
          AND tx_type = 'Payment'
        ORDER BY timestamp_iso DESC
        LIMIT 1
      `).get(
        config.subsProtocolAddress,
        subscriber,
        config.serviceId,
      ) as { amount_drops: number } | undefined;

      const reason: SubsReason = anyPayment && anyPayment.amount_drops < minDrops
        ? "PAYMENT_INSUFFICIENT"
        : "NO_QUALIFYING_PAYMENT";

      return {
        entitled: false,
        state: "inactive",
        reason,
        subscriber,
        serviceId: config.serviceId,
        currentPeriod: null,
        lifetime,
        freshness,
      };
    }

    // Had a qualifying payment, but it expired
    const expiresAt = new Date(latestEver.timestamp_iso);
    expiresAt.setDate(expiresAt.getDate() + config.periodDays);

    return {
      entitled: false,
      state: "expired",
      reason: "PAYMENT_EXPIRED",
      subscriber,
      serviceId: config.serviceId,
      currentPeriod: {
        startedAt: latestEver.timestamp_iso,
        expiresAt: expiresAt.toISOString(),
        paymentTx: latestEver.tx_hash,
        amountPft: latestEver.amount_drops / 1_000_000,
      },
      lifetime,
      freshness,
    };
  }

  // ── Qualifying payment found in period ──────────────────────────

  const paymentTime = new Date(activePeriodPayment.timestamp_iso);
  const expiresAt = new Date(paymentTime);
  expiresAt.setDate(expiresAt.getDate() + config.periodDays);

  // Determine if in grace period (approaching expiry)
  const graceThreshold = new Date(expiresAt);
  graceThreshold.setHours(graceThreshold.getHours() - gracePeriodHours);

  const inGracePeriod = now >= graceThreshold && now < expiresAt;
  const state: SubsState = inGracePeriod ? "expiring" : "active";
  const reason: SubsReason = inGracePeriod ? "PAYMENT_VALID_GRACE_PERIOD" : "PAYMENT_VALID";

  return {
    entitled: true,
    state,
    reason,
    subscriber,
    serviceId: config.serviceId,
    currentPeriod: {
      startedAt: activePeriodPayment.timestamp_iso,
      expiresAt: expiresAt.toISOString(),
      paymentTx: activePeriodPayment.tx_hash,
      amountPft: activePeriodPayment.amount_drops / 1_000_000,
    },
    lifetime,
    freshness,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

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
  const note = indexedAt
    ? `Index as of ${indexedAt} (${agoMinutes}m ago, ${stale ? "STALE — exceeds freshness window" : "within freshness window"})`
    : "Index freshness unknown — crawl_state not available";

  return {
    resolvedAt,
    indexedAt,
    stalenessSeconds,
    stale,
    note,
  };
}

// ─── Batch Check (for marketplace/dashboard) ────────────────────────

/**
 * Check entitlement for multiple subscribers against a single service.
 * Useful for building subscriber lists and dashboards.
 */
export function checkEntitlementBatch(
  db: Database.Database,
  config: SubsServiceConfig,
  subscribers: string[],
): SubsEntitlementResult[] {
  return subscribers.map(sub => checkEntitlement(db, config, sub));
}

/**
 * Get all active subscribers for a service.
 * Returns addresses of all subscribers with qualifying payments within the billing period.
 */
export function getActiveSubscribers(
  db: Database.Database,
  config: SubsServiceConfig,
): string[] {
  const minDrops = config.pricePft * 1_000_000;
  const periodClause = `-${config.periodDays} days`;

  const rows = db.prepare(`
    SELECT DISTINCT account
    FROM transactions
    WHERE destination = ?
      AND memo_type = 'subs.subscribe'
      AND memo_data_preview LIKE '%' || ? || '%'
      AND CAST(amount_drops AS INTEGER) >= ?
      AND tx_type = 'Payment'
      AND timestamp_iso > datetime('now', ?)
  `).all(
    config.subsProtocolAddress,
    config.serviceId,
    minDrops,
    periodClause,
  ) as { account: string }[];

  return rows.map(r => r.account);
}
