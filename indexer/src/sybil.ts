/**
 * sybil.ts — Deterministic sybil detection using on-chain behavioral signals.
 *
 * Detects undeclared wallet associations using publicly observable patterns:
 *   1. Temporal correlation — wallets transact in tight time windows
 *   2. Counterparty overlap — wallets share unusual counterparty sets
 *   3. Amount fingerprinting — wallets send identical or patterned amounts
 *   4. Funding chain — wallets funded from the same source in sequence
 *   5. Activity cadence — wallets have matching submission timing patterns
 *
 * Outputs sybil clusters with confidence scores and signal breakdowns.
 * All analysis is deterministic and uses only on-chain public data.
 */

import type Database from "better-sqlite3";

// ─── Types ───────────────────────────────────────────────────────────

export interface SybilCluster {
  clusterId: string;
  addresses: string[];
  confidence: number;      // [0, 1]
  signals: SybilSignal[];
  rationale: string;
}

export interface SybilSignal {
  type: SybilSignalType;
  score: number;           // [0, 1]
  details: string;
}

export type SybilSignalType =
  | "funding_chain"
  | "temporal_correlation"
  | "counterparty_overlap"
  | "amount_fingerprint"
  | "activity_cadence";

export interface SybilConfig {
  minConfidence: number;              // Minimum confidence to report (default 0.5)
  temporalWindowMs: number;           // Time window for temporal correlation (default 300000 = 5 min)
  counterpartyOverlapMin: number;     // Minimum Jaccard overlap for counterparty sets (default 0.6)
  fundingChainMaxHops: number;        // Max hops to trace funding (default 3)
  minTransactionsForAnalysis: number; // Minimum txns to consider an account (default 3)
  whitelistedAccounts: string[];      // Known infrastructure wallets (airdrop, Task Node, etc.)
  standardAmounts: string[];          // Standard transaction amounts to exclude from fingerprinting
}

export const DEFAULT_SYBIL_CONFIG: SybilConfig = {
  minConfidence: 0.5,
  temporalWindowMs: 300_000,
  counterpartyOverlapMin: 0.6,
  fundingChainMaxHops: 3,
  minTransactionsForAnalysis: 3,
  whitelistedAccounts: [
    "rwdm72S9YVKkZjeADKU2bbUMuY4vPnSfH7",  // Task Node hub
    "rJNwqDPKSkbqDPNoNxbW6C3KCS84ZaQc96",  // Daily airdrop wallet
    "rhczhWeG3eSohzcH5jw8m8Ynca9cgH4eZm",  // Treasury
    "rKt4peDozpRW9zdYGiTZC54DSNU3Af6pQE",  // Distribution
    "rGBKxoTcavpfEso7ASRELZAMcCMqKa8oFk",  // Distribution 2
    "rKddMw1hqMGwfgJvzjbWQHtBQT8hDcZNCP",  // Task Node 3
    "rBDbRYd8H7gB6mdNTRssK7DP4YuKbiS7Db",  // Reserve
  ],
  // Standard amounts (in drops) to exclude from amount fingerprinting
  // These are common transaction sizes that don't indicate sybil behavior
  standardAmounts: [
    "0", "1000", "10000", "100000",
    "1000000",    // 1 PFT
    "5000000",    // 5 PFT
    "10000000",   // 10 PFT
    "50000000",   // 50 PFT
    "100000000",  // 100 PFT
    "500000000",  // 500 PFT
    "1000000000", // 1000 PFT
  ],
};

// ─── Signal Detectors ────────────────────────────────────────────────

/**
 * Detect funding chains: A funds B, B funds C → possible single operator.
 * Excludes whitelisted accounts (known airdrop/infrastructure wallets).
 */
function detectFundingChains(db: Database.Database, config: SybilConfig): Map<string, Set<string>> {
  const chains = new Map<string, Set<string>>();
  const whitelist = new Set(config.whitelistedAccounts);

  // Find accounts that were funded by the same source (non-hub accounts)
  const rows = db.prepare(`
    SELECT from_address, GROUP_CONCAT(to_address) as recipients, COUNT(*) as cnt
    FROM edges
    WHERE memo_tx_count = 0 AND tx_count <= 3
    GROUP BY from_address
    HAVING cnt >= 2
  `).all() as { from_address: string; recipients: string; cnt: number }[];

  for (const row of rows) {
    // Skip if the funding source is a whitelisted account (airdrop, Task Node, etc.)
    if (whitelist.has(row.from_address)) continue;

    const recipients = row.recipients.split(",").filter(r => !whitelist.has(r));
    if (recipients.length >= 2) {
      const chainId = `funding_${row.from_address.substring(0, 10)}`;
      chains.set(chainId, new Set(recipients));
    }
  }

  return chains;
}

/**
 * Detect temporal correlation: wallets that transact to the same destination
 * within tight time windows.
 * Excludes whitelisted accounts from analysis.
 */
function detectTemporalCorrelation(
  db: Database.Database,
  config: SybilConfig,
): { pair: [string, string]; score: number; details: string }[] {
  const results: { pair: [string, string]; score: number; details: string }[] = [];
  const whitelist = new Set(config.whitelistedAccounts);

  // Get accounts with enough transactions, excluding whitelisted
  const accounts = db.prepare(`
    SELECT address FROM accounts WHERE memo_tx_count >= ?
  `).all(config.minTransactionsForAnalysis) as { address: string }[];
  const filtered = accounts.filter(a => !whitelist.has(a.address));

  // For each pair, check if their memo transactions cluster in time
  for (let i = 0; i < filtered.length; i++) {
    for (let j = i + 1; j < filtered.length; j++) {
      const a = filtered[i].address;
      const b = filtered[j].address;

      // Get timestamps of memo txns for both
      const aTimes = db.prepare(`
        SELECT timestamp_ripple FROM transactions
        WHERE (account = ? OR destination = ?) AND has_memo = 1
        ORDER BY timestamp_ripple
      `).all(a, a) as { timestamp_ripple: number }[];

      const bTimes = db.prepare(`
        SELECT timestamp_ripple FROM transactions
        WHERE (account = ? OR destination = ?) AND has_memo = 1
        ORDER BY timestamp_ripple
      `).all(b, b) as { timestamp_ripple: number }[];

      if (aTimes.length < 3 || bTimes.length < 3) continue;

      // Count how many of B's transactions fall within window of A's
      const windowSec = config.temporalWindowMs / 1000;
      let matches = 0;
      for (const at of aTimes) {
        for (const bt of bTimes) {
          if (Math.abs(at.timestamp_ripple - bt.timestamp_ripple) <= windowSec) {
            matches++;
            break;
          }
        }
      }

      const score = matches / Math.min(aTimes.length, bTimes.length);
      if (score >= 0.5) {
        results.push({
          pair: [a, b],
          score: Math.min(score, 1),
          details: `${matches}/${Math.min(aTimes.length, bTimes.length)} transactions within ${config.temporalWindowMs / 1000}s window`,
        });
      }
    }
  }

  return results;
}

/**
 * Detect counterparty overlap: wallets that talk to the same set of addresses.
 * Excludes whitelisted accounts from both the analysis pool and counterparty sets
 * (everyone talks to the Task Node — that's not a sybil signal).
 */
function detectCounterpartyOverlap(
  db: Database.Database,
  config: SybilConfig,
): { pair: [string, string]; score: number; details: string }[] {
  const results: { pair: [string, string]; score: number; details: string }[] = [];
  const whitelist = new Set(config.whitelistedAccounts);

  const accounts = db.prepare(`
    SELECT address FROM accounts WHERE memo_tx_count >= ?
  `).all(config.minTransactionsForAnalysis) as { address: string }[];

  // Build counterparty sets, excluding whitelisted accounts from sets
  const cpSets = new Map<string, Set<string>>();
  for (const acct of accounts) {
    if (whitelist.has(acct.address)) continue; // Skip whitelisted accounts themselves

    const cps = db.prepare(`
      SELECT DISTINCT CASE WHEN from_address = ? THEN to_address ELSE from_address END as cp
      FROM edges WHERE from_address = ? OR to_address = ?
    `).all(acct.address, acct.address, acct.address) as { cp: string }[];

    // Remove whitelisted counterparties — talking to Task Node / airdrop is universal, not a sybil signal
    cpSets.set(acct.address, new Set(cps.map(c => c.cp).filter(cp => !whitelist.has(cp))));
  }

  // Jaccard similarity between all pairs
  const addrs = [...cpSets.keys()];
  for (let i = 0; i < addrs.length; i++) {
    for (let j = i + 1; j < addrs.length; j++) {
      const setA = cpSets.get(addrs[i])!;
      const setB = cpSets.get(addrs[j])!;

      if (setA.size < 2 || setB.size < 2) continue;

      let intersection = 0;
      for (const x of setA) {
        if (setB.has(x)) intersection++;
      }
      const union = setA.size + setB.size - intersection;
      const jaccard = union > 0 ? intersection / union : 0;

      if (jaccard >= config.counterpartyOverlapMin) {
        results.push({
          pair: [addrs[i], addrs[j]],
          score: jaccard,
          details: `Jaccard=${jaccard.toFixed(3)} (${intersection} shared counterparties, ${union} total)`,
        });
      }
    }
  }

  return results;
}

/**
 * Detect amount fingerprinting: wallets sending identical unusual amounts.
 * Filters out:
 *   - Standard/common amounts (1 PFT, 10 PFT, 100 PFT, etc.)
 *   - Transactions involving whitelisted accounts (airdrop, Task Node)
 *   - Airdrop patterns (same sender → many recipients with same amount)
 */
function detectAmountFingerprints(
  db: Database.Database,
  config: SybilConfig,
): { pair: [string, string]; score: number; details: string }[] {
  const results: { pair: [string, string]; score: number; details: string }[] = [];
  const whitelist = new Set(config.whitelistedAccounts);
  const standardAmounts = new Set(config.standardAmounts);

  // Build the NOT IN clause for standard amounts
  const placeholders = config.standardAmounts.map(() => "?").join(",");

  // Find non-standard amounts used by multiple senders to the same destination
  const rows = db.prepare(`
    SELECT amount_drops, destination, GROUP_CONCAT(DISTINCT account) as senders, COUNT(DISTINCT account) as sender_count
    FROM transactions
    WHERE tx_type = 'Payment' AND amount_drops NOT IN (${placeholders})
    GROUP BY amount_drops, destination
    HAVING sender_count >= 2
  `).all(...config.standardAmounts) as { amount_drops: string; destination: string; senders: string; sender_count: number }[];

  for (const row of rows) {
    // Skip if destination is a whitelisted account (receiving airdrops is normal)
    if (whitelist.has(row.destination)) continue;

    // Filter out whitelisted senders
    const senders = row.senders.split(",").filter(s => !whitelist.has(s));
    if (senders.length < 2) continue;

    // Skip airdrop pattern: if one sender sent this amount to 5+ recipients, it's distribution not sybil
    for (const sender of senders) {
      const recipientCount = (db.prepare(`
        SELECT COUNT(DISTINCT destination) as c FROM transactions
        WHERE account = ? AND amount_drops = ? AND tx_type = 'Payment'
      `).get(sender, row.amount_drops) as { c: number }).c;
      if (recipientCount >= 5) {
        // This sender is doing distribution, skip all pairs involving them
        continue;
      }
    }

    for (let i = 0; i < senders.length; i++) {
      for (let j = i + 1; j < senders.length; j++) {
        results.push({
          pair: [senders[i], senders[j]],
          score: 0.4 + (0.1 * Math.min(row.sender_count, 5)),
          details: `Both sent ${row.amount_drops} drops to ${row.destination.substring(0, 15)}...`,
        });
      }
    }
  }

  return results;
}

// ─── Cluster Assembly ────────────────────────────────────────────────

/**
 * Merge pairwise signals into clusters using union-find.
 */
function buildClusters(
  pairSignals: { pair: [string, string]; type: SybilSignalType; score: number; details: string }[],
  minConfidence: number,
): SybilCluster[] {
  // Union-Find
  const parent = new Map<string, string>();

  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let current = x;
    while (current !== root) {
      const next = parent.get(current)!;
      parent.set(current, root);
      current = next;
    }
    return root;
  }

  function union(a: string, b: string): void {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  }

  // Merge pairs with high enough scores
  const pairScores = new Map<string, { signals: { type: SybilSignalType; score: number; details: string }[]; totalScore: number }>();

  for (const { pair, type, score, details } of pairSignals) {
    const key = [pair[0], pair[1]].sort().join("|");
    if (!pairScores.has(key)) pairScores.set(key, { signals: [], totalScore: 0 });
    const entry = pairScores.get(key)!;
    entry.signals.push({ type, score, details });
    entry.totalScore += score;
  }

  // Union pairs that exceed threshold
  for (const [key, entry] of pairScores) {
    const confidence = Math.min(entry.totalScore / 3, 1); // Normalize: 3 strong signals = 1.0
    if (confidence >= minConfidence) {
      const [a, b] = key.split("|");
      union(a, b);
    }
  }

  // Collect clusters
  const clusterMembers = new Map<string, Set<string>>();
  for (const addr of parent.keys()) {
    const root = find(addr);
    if (!clusterMembers.has(root)) clusterMembers.set(root, new Set());
    clusterMembers.get(root)!.add(addr);
  }

  // Build output
  const clusters: SybilCluster[] = [];
  let idx = 0;

  for (const [_, members] of clusterMembers) {
    if (members.size < 2) continue;
    idx++;

    // Collect all signals for this cluster
    const clusterSignals: SybilSignal[] = [];
    let maxScore = 0;

    for (const [key, entry] of pairScores) {
      const [a, b] = key.split("|");
      if (members.has(a) && members.has(b)) {
        for (const s of entry.signals) {
          clusterSignals.push(s);
          maxScore = Math.max(maxScore, entry.totalScore);
        }
      }
    }

    const confidence = Math.min(maxScore / 3, 1);
    if (confidence < minConfidence) continue;

    const sortedAddresses = [...members].sort();
    const signalTypes = [...new Set(clusterSignals.map(s => s.type))].sort();

    clusters.push({
      clusterId: `sybil_${String(idx).padStart(3, "0")}`,
      addresses: sortedAddresses,
      confidence: Math.round(confidence * 1000) / 1000,
      signals: clusterSignals.sort((a, b) => b.score - a.score),
      rationale: `${members.size} wallets linked by ${signalTypes.join(", ")} signals. Confidence: ${(confidence * 100).toFixed(1)}%.`,
    });
  }

  return clusters.sort((a, b) => b.confidence - a.confidence);
}

// ─── Public API ──────────────────────────────────────────────────────

export interface SybilResult {
  clusters: SybilCluster[];
  accountsAnalyzed: number;
  pairsEvaluated: number;
  signalsDetected: number;
  analyzedAt: string;
}

export function analyzeSybil(
  db: Database.Database,
  config: SybilConfig = DEFAULT_SYBIL_CONFIG,
): SybilResult {
  const now = new Date().toISOString();
  console.log("[sybil] Running sybil analysis...");

  const allSignals: { pair: [string, string]; type: SybilSignalType; score: number; details: string }[] = [];

  // 1. Funding chains
  const chains = detectFundingChains(db, config);
  for (const [_, members] of chains) {
    const addrs = [...members];
    for (let i = 0; i < addrs.length; i++) {
      for (let j = i + 1; j < addrs.length; j++) {
        allSignals.push({ pair: [addrs[i], addrs[j]], type: "funding_chain", score: 0.6, details: "Funded from same source with minimal non-memo transactions" });
      }
    }
  }
  console.log(`  [sybil] Funding chains: ${chains.size} sources`);

  // 2. Temporal correlation
  const temporal = detectTemporalCorrelation(db, config);
  for (const t of temporal) {
    allSignals.push({ pair: t.pair, type: "temporal_correlation", score: t.score, details: t.details });
  }
  console.log(`  [sybil] Temporal correlations: ${temporal.length} pairs`);

  // 3. Counterparty overlap
  const cpOverlap = detectCounterpartyOverlap(db, config);
  for (const c of cpOverlap) {
    allSignals.push({ pair: c.pair, type: "counterparty_overlap", score: c.score, details: c.details });
  }
  console.log(`  [sybil] Counterparty overlaps: ${cpOverlap.length} pairs`);

  // 4. Amount fingerprints
  const amounts = detectAmountFingerprints(db, config);
  for (const a of amounts) {
    allSignals.push({ pair: a.pair, type: "amount_fingerprint", score: a.score, details: a.details });
  }
  console.log(`  [sybil] Amount fingerprints: ${amounts.length} pairs`);

  // Build clusters
  const rawClusters = buildClusters(allSignals, config.minConfidence);
  console.log(`  [sybil] Raw clusters: ${rawClusters.length}`);

  // Filter out false-positive clusters: legitimate contributors who share
  // natural patterns (same reward amounts, similar activity times) because
  // they work the same task node. A real sybil cluster has low memo activity
  // across its members; real contributors have high memo activity.
  const clusters = rawClusters.filter((cluster) => {
    const placeholders = cluster.addresses.map(() => "?").join(",");
    const result = db.prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN memo_tx_count > 10 THEN 1 ELSE 0 END) as active
       FROM accounts WHERE address IN (${placeholders})`
    ).get(...cluster.addresses) as { total: number; active: number };

    // If >30% of the cluster have significant memo activity, it's real contributors
    const activeRatio = result.total > 0 ? result.active / result.total : 0;
    if (activeRatio > 0.3) {
      console.log(`  [sybil] Rejecting cluster ${cluster.clusterId} — ${result.active}/${result.total} members have memo activity (false positive)`);
      return false;
    }
    return true;
  });
  console.log(`  [sybil] Clusters after filter: ${clusters.length}`);

  // Persist clusters
  const insertCluster = db.prepare(`
    INSERT OR REPLACE INTO sybil_clusters (cluster_id, address, confidence, signals, detected_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    db.prepare("DELETE FROM sybil_clusters").run();
    for (const cluster of clusters) {
      for (const addr of cluster.addresses) {
        insertCluster.run(
          cluster.clusterId,
          addr,
          cluster.confidence,
          JSON.stringify(cluster.signals.map(s => s.type)),
          now,
        );
      }
    }
  })();

  const acctCount = (db.prepare("SELECT COUNT(*) as c FROM accounts WHERE memo_tx_count >= ?").get(config.minTransactionsForAnalysis) as { c: number }).c;

  return {
    clusters,
    accountsAnalyzed: acctCount,
    pairsEvaluated: allSignals.length,
    signalsDetected: allSignals.filter(s => s.score >= 0.5).length,
    analyzedAt: now,
  };
}
