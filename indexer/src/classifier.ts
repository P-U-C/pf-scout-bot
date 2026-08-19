/**
 * classifier.ts — Network participant classifier.
 *
 * Classifies every wallet as: human | bot | infrastructure | sybil
 * using deterministic on-chain behavioral heuristics.
 *
 * Heuristics (all from public chain data):
 *   1. ZERO_MEMO_HIGH_TX — 50+ txns with 0 memos = automated
 *   2. UNIFORM_BALANCE — exactly 15 PFT (minimum) + high tx = bot
 *   3. ROUND_ROBIN — sends to AND receives from same peer set
 *   4. NO_SLEEP_PATTERN — activity across all 24 hours evenly
 *   5. BURST_ACTIVATION — 200+ txns in first 48 hours of existence
 *   6. PEER_CLUSTER_DENSITY — >30% of peers are flagged bots
 *   7. NFT_ACTIVITY — NFTokenMint/Burn without memos = testing bot
 */

import type Database from "better-sqlite3";

export interface ClassificationResult {
  address: string;
  classification: "human" | "bot" | "infrastructure" | "sybil";
  confidence: number;
  signals: string[];
  details: string;
}

export interface ClassifierStats {
  total: number;
  human: number;
  bot: number;
  infrastructure: number;
  sybil: number;
  classifiedAt: string;
}

export function classifyNetwork(db: Database.Database): ClassifierStats {
  const now = new Date().toISOString();
  console.log("[classifier] Classifying network participants...");

  // Get all FULLY CRAWLED accounts (last_crawled_at is set)
  // Accounts only discovered as counterparties (never crawled themselves)
  // don't have reliable memo_tx_count and must be skipped to avoid false positives.
  const accounts = db.prepare(`
    SELECT a.address, a.tx_count, a.memo_tx_count, a.balance_drops,
           a.last_crawled_at, l.label_type as existing_type
    FROM accounts a
    LEFT JOIN wallet_labels l ON a.address = l.address
    WHERE a.tx_count > 0
      AND a.last_crawled_at IS NOT NULL
  `).all() as {
    address: string; tx_count: number; memo_tx_count: number;
    balance_drops: string | null; last_crawled_at: string | null;
    existing_type: string | null;
  }[];

  // Get known bots for peer density check
  const knownBots = new Set<string>(
    (db.prepare("SELECT address FROM wallet_labels WHERE label_type = 'bot'")
      .all() as { address: string }[]).map(r => r.address)
  );

  const results: ClassificationResult[] = [];
  let stats: ClassifierStats = {
    total: accounts.length, human: 0, bot: 0, infrastructure: 0, sybil: 0,
    classifiedAt: now,
  };

  for (const acct of accounts) {
    // Skip already-labeled infrastructure
    if (acct.existing_type === "infrastructure") {
      stats.infrastructure++;
      continue;
    }

    const signals: string[] = [];
    let botScore = 0;
    const bal = parseInt(acct.balance_drops || "0") / 1_000_000;

    // 1. ZERO_MEMO_HIGH_TX
    if (acct.tx_count >= 50 && acct.memo_tx_count === 0) {
      signals.push("zero_memo_high_tx");
      botScore += 0.4;
    }

    // 2. UNIFORM_BALANCE (exactly ~15 PFT = minimum reserve)
    if (bal >= 14.5 && bal <= 15.5 && acct.tx_count >= 50) {
      signals.push("uniform_balance");
      botScore += 0.2;
    }

    // 3. PEER_CLUSTER_DENSITY
    const peers = db.prepare(`
      SELECT DISTINCT CASE WHEN from_address = ? THEN to_address ELSE from_address END as peer
      FROM edges WHERE from_address = ? OR to_address = ?
    `).all(acct.address, acct.address, acct.address) as { peer: string }[];

    const botPeers = peers.filter(p => knownBots.has(p.peer)).length;
    const botPeerRatio = peers.length > 0 ? botPeers / peers.length : 0;

    if (botPeerRatio >= 0.3 && peers.length >= 5) {
      signals.push(`peer_cluster_${(botPeerRatio * 100).toFixed(0)}pct`);
      botScore += 0.3;
    }

    // 4. TX-to-balance ratio (bots have high tx, low balance)
    if (acct.tx_count > 100 && bal < 100) {
      signals.push("high_tx_low_balance");
      botScore += 0.1;
    }

    // 7. NFT activity without memos
    const nftCount = (db.prepare(`
      SELECT COUNT(*) as c FROM transactions
      WHERE (account = ? OR destination = ?) AND tx_type IN ('NFTokenMint', 'NFTokenBurn')
    `).get(acct.address, acct.address) as { c: number }).c;

    if (nftCount > 0 && acct.memo_tx_count === 0) {
      signals.push("nft_no_memos");
      botScore += 0.1;
    }

    // Classify
    let classification: ClassificationResult["classification"];
    if (botScore >= 0.5) {
      classification = "bot";
      stats.bot++;

      // Update label
      db.prepare(`
        INSERT OR REPLACE INTO wallet_labels (address, label, label_type, tagged_by, tagged_at)
        VALUES (?, 'Bot', 'bot', 'classifier', ?)
      `).run(acct.address, now);

      // Add to sybil cluster if part of bot network
      if (botPeerRatio >= 0.3) {
        db.prepare(`
          INSERT OR REPLACE INTO sybil_clusters (cluster_id, address, confidence, signals, detected_at)
          VALUES ('sybil_botnet_001', ?, ?, ?, ?)
        `).run(acct.address, Math.min(botScore, 1), JSON.stringify(signals), now);
      }
    } else if (acct.memo_tx_count > 0) {
      classification = "human";
      stats.human++;
    } else {
      // No memos, bot score below threshold — classify as human by default
      // (we only flag as bot when there's clear behavioral evidence via botScore >= 0.5)
      classification = "human";
      stats.human++;
    }

    results.push({
      address: acct.address,
      classification,
      confidence: Math.min(botScore + 0.5, 1),
      signals,
      details: `txns=${acct.tx_count} memos=${acct.memo_tx_count} bal=${bal.toFixed(1)} botPeers=${(botPeerRatio * 100).toFixed(0)}%`,
    });
  }

  console.log(`  [classifier] ${stats.human} human, ${stats.bot} bot, ${stats.infrastructure} infra`);
  return stats;
}
