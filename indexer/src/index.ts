/**
 * PFTL Chain Indexer — Entry Point
 *
 * Commands:
 *   crawl     — Crawl outward from seed accounts, index all transactions
 *   sybil     — Run sybil analysis on indexed data
 *   export    — Export indexed data as JSON
 *   stats     — Show index statistics
 *   backfill  — Full backfill (alias for crawl with higher depth)
 */

import { openDb } from "./db.js";
import { crawl, DEFAULT_CONFIG } from "./crawler.js";
import { analyzeSybil, DEFAULT_SYBIL_CONFIG, type SybilResult } from "./sybil.js";
import { classifyNetwork } from "./classifier.js";
import type Database from "better-sqlite3";

// ─── Seed Accounts ──────────────────────────────────────────────────

// Seed accounts for crawling the PFTL network.
// Includes all known infrastructure + the operator wallet.
const SEED_ACCOUNTS = [
  "rsS2Y6CK9dz9dVFjJvRyD2gBdoLPqjaXRZ", // Operator (Zoz)
  "rwdm72S9YVKkZjeADKU2bbUMuY4vPnSfH7", // Task Node hub
  "rJNwqDPKSkbqDPNoNxbW6C3KCS84ZaQc96", // Task Node (Reward 3)
  "rGBKxoTcavpfEso7ASRELZAMcCMqKa8oFk", // Task Node (Reward 1)
  "rKt4peDozpRW9zdYGiTZC54DSNU3Af6pQE", // Task Node (Reward 2)
  "r3hH6UNw1eVQYiXbDVoarp2kN6JKyTYveT", // Lens Bot
  "r9XYDxJDbmmhSGNpUguVhea6xn3Tu2HbeF", // SUBS Bot
];

// ─── Commands ───────────────────────────────────────────────────────

async function cmdCrawl(db: Database.Database, depth: number = 3): Promise<void> {
  console.log(`[indexer] Starting crawl (depth=${depth})...`);
  const result = await crawl(db, SEED_ACCOUNTS, { ...DEFAULT_CONFIG, maxDepth: depth });

  // Recompute account aggregates from the transactions table.
  // The crawler writes per-page counts which get stale when an account is
  // re-crawled on a later ledger range, so we rebuild the totals here.
  console.log(`[indexer] Recomputing account aggregates...`);
  db.exec(`
    UPDATE accounts SET tx_count = (
      SELECT COUNT(*) FROM transactions WHERE transactions.account = accounts.address
    );
    UPDATE accounts SET memo_tx_count = (
      SELECT COUNT(*) FROM transactions
      WHERE transactions.account = accounts.address AND has_memo = 1
    );
  `);

  // Refresh balances from the node for all accounts.
  // The crawler only sets balance when an account is first discovered,
  // so balances go stale as accounts transact. One pass keeps them fresh.
  console.log(`[indexer] Refreshing balances from node...`);
  const rpcUrl = process.env.PFTL_RPC_URL ?? "http://127.0.0.1:5015";
  const addresses = db.prepare("SELECT address FROM accounts").all() as { address: string }[];
  let refreshed = 0;
  for (const { address } of addresses) {
    try {
      const resp = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "account_info",
          params: [{ account: address, ledger_index: "validated" }],
        }),
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) continue;
      const data = await resp.json() as {
        result?: { account_data?: { Balance?: string }; status?: string };
      };
      if (data.result?.status === "error") continue;
      const balance = data.result?.account_data?.Balance ?? "0";
      db.prepare("UPDATE accounts SET balance_drops = ? WHERE address = ?").run(balance, address);
      refreshed++;
    } catch {
      // Skip on error
    }
  }
  console.log(`  Refreshed ${refreshed}/${addresses.length} balances`);

  console.log(`\n[indexer] Crawl complete:`);
  console.log(`  Accounts crawled: ${result.accountsCrawled}`);
  console.log(`  Accounts discovered: ${result.accountsDiscovered}`);
  console.log(`  Transactions indexed: ${result.transactionsIndexed}`);
  console.log(`  Memo transactions: ${result.memoTransactions}`);
}

async function cmdSybil(db: Database.Database): Promise<void> {
  const result = analyzeSybil(db, DEFAULT_SYBIL_CONFIG);
  console.log(`\n[indexer] Sybil analysis complete:`);
  console.log(`  Accounts analyzed: ${result.accountsAnalyzed}`);
  console.log(`  Pairs evaluated: ${result.pairsEvaluated}`);
  console.log(`  Signals detected: ${result.signalsDetected}`);
  console.log(`  Clusters found: ${result.clusters.length}`);

  for (const cluster of result.clusters) {
    const signalCounts = new Map<string, number>();
    for (const s of cluster.signals) signalCounts.set(s.type, (signalCounts.get(s.type) ?? 0) + 1);
    const signalSummary = [...signalCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, n]) => `${type} x${n}`)
      .join(", ");
    const shownAddresses = cluster.addresses.slice(0, 10);
    const moreAddresses = cluster.addresses.length - shownAddresses.length;

    console.log(`\n  Cluster ${cluster.clusterId} (confidence: ${(cluster.confidence * 100).toFixed(1)}%):`);
    console.log(
      `    Addresses (${cluster.addresses.length}): ${shownAddresses.join(", ")}` +
        (moreAddresses > 0 ? `, +${moreAddresses} more` : ""),
    );
    console.log(`    Signals: ${signalSummary}`);
    console.log(`    ${cluster.rationale}`);
  }
}

function cmdStats(db: Database.Database): void {
  const accounts = (db.prepare("SELECT COUNT(*) as c FROM accounts").get() as { c: number }).c;
  const memoAccounts = (db.prepare("SELECT COUNT(*) as c FROM accounts WHERE memo_tx_count > 0").get() as { c: number }).c;
  const txns = (db.prepare("SELECT COUNT(*) as c FROM transactions").get() as { c: number }).c;
  const memoTxns = (db.prepare("SELECT COUNT(*) as c FROM transactions WHERE has_memo = 1").get() as { c: number }).c;
  const edges = (db.prepare("SELECT COUNT(*) as c FROM edges").get() as { c: number }).c;
  const clusters = (db.prepare("SELECT COUNT(DISTINCT cluster_id) as c FROM sybil_clusters").get() as { c: number }).c;

  console.log(`[indexer] Chain Index Stats:`);
  console.log(`  Accounts: ${accounts} (${memoAccounts} with memos)`);
  console.log(`  Transactions: ${txns} (${memoTxns} with memos)`);
  console.log(`  Edges: ${edges}`);
  console.log(`  Sybil clusters: ${clusters}`);
}

function cmdExport(db: Database.Database): void {
  const accounts = db.prepare("SELECT * FROM accounts ORDER BY memo_tx_count DESC").all();
  const edges = db.prepare("SELECT * FROM edges ORDER BY memo_tx_count DESC").all();
  const clusters = db.prepare("SELECT * FROM sybil_clusters ORDER BY cluster_id, address").all();
  const stats = {
    exported_at: new Date().toISOString(),
    account_count: accounts.length,
    edge_count: edges.length,
    cluster_count: new Set((clusters as { cluster_id: string }[]).map(c => c.cluster_id)).size,
  };

  console.log(JSON.stringify({ stats, accounts, edges, sybil_clusters: clusters }, null, 2));
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const command = process.argv[2] ?? "crawl";
  const db = openDb();

  try {
    switch (command) {
      case "crawl":
        await cmdCrawl(db);
        break;
      case "backfill":
        await cmdCrawl(db, 5);
        break;
      case "sybil":
        await cmdSybil(db);
        break;
      case "stats":
        cmdStats(db);
        break;
      case "export":
        cmdExport(db);
        break;
      case "classify":
        classifyNetwork(db);
        cmdStats(db);
        break;
      case "all":
        await cmdCrawl(db);
        classifyNetwork(db);
        await cmdSybil(db);
        cmdStats(db);
        break;
      default:
        console.log("Usage: pftl-indexer <crawl|backfill|sybil|stats|export|all>");
    }
  } finally {
    db.close();
  }
}

main().catch(console.error);
