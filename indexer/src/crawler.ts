/**
 * crawler.ts — Outward-crawling chain indexer for the PFTL network.
 *
 * Strategy: seed from known accounts, discover counterparties, crawl outward.
 * Resumable — tracks last-crawled state per account.
 * Composable — new accounts are discovered automatically as the network grows.
 */

import { Client } from "xrpl";
import type { AccountTxTransaction } from "xrpl";
import type Database from "better-sqlite3";
import { getCrawlState, setCrawlState } from "./db.js";

// ─── Config ──────────────────────────────────────────────────────────

export interface CrawlerConfig {
  rpcUrl: string;
  maxDepth: number;         // How many hops from seed accounts
  txLimitPerAccount: number; // Max transactions to fetch per account (0 = all)
  rateLimitMs: number;       // Delay between RPC calls
}

export const DEFAULT_CONFIG: CrawlerConfig = {
  rpcUrl: process.env.PFTL_RPC_URL ?? "http://127.0.0.1:5015",
  maxDepth: 3,
  txLimitPerAccount: 0,  // Fetch all
  rateLimitMs: 100,
};

// ─── RPC Helpers ─────────────────────────────────────────────────────

async function rpcPost(url: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ method, params: [params] });
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const data = await resp.json() as { result: Record<string, unknown> };
  return data.result;
}

async function getAllAccountTx(
  rpcUrl: string,
  account: string,
  limit: number = 0,
  rateLimitMs: number = 100,
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let marker: unknown = undefined;
  let pages = 0;
  const maxPages = limit > 0 ? Math.ceil(limit / 400) : 50;

  while (pages < maxPages) {
    const params: Record<string, unknown> = {
      account,
      limit: 400,
      ledger_index_min: -1,
      ledger_index_max: -1,
    };
    if (marker) params.marker = marker;

    try {
      const result = await rpcPost(rpcUrl, "account_tx", params);
      const txns = (result.transactions ?? []) as Record<string, unknown>[];
      all.push(...txns);
      marker = result.marker;
      pages++;
      if (!marker || txns.length === 0) break;
      if (limit > 0 && all.length >= limit) break;
      await sleep(rateLimitMs);
    } catch {
      break;
    }
  }
  return limit > 0 ? all.slice(0, limit) : all;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Memo Extraction ─────────────────────────────────────────────────

function hexToUtf8(hex: string): string {
  try {
    return Buffer.from(hex, "hex").toString("utf8");
  } catch {
    return "";
  }
}

interface ParsedMemo {
  memoType: string;
  memoData: string;
  cid: string | null;
}

function parseMemo(memos: unknown[]): ParsedMemo | null {
  if (!Array.isArray(memos) || memos.length === 0) return null;
  const first = (memos[0] as { Memo?: { MemoType?: string; MemoData?: string } })?.Memo;
  if (!first) return null;

  const memoType = first.MemoType ? hexToUtf8(first.MemoType) : "";
  const memoData = first.MemoData ? hexToUtf8(first.MemoData) : "";

  // Extract IPFS CID if present (bafk... pattern)
  const cidMatch = memoData.match(/(bafkrei[a-z2-7]{46,})/);
  const cid = cidMatch ? cidMatch[1] : null;

  return { memoType, memoData, cid };
}

// ─── Ripple Epoch → ISO ──────────────────────────────────────────────

const RIPPLE_EPOCH = 946684800; // 2000-01-01T00:00:00Z

function rippleTimeToISO(rippleTime: number): string {
  return new Date((rippleTime + RIPPLE_EPOCH) * 1000).toISOString();
}

// ─── Transaction Indexing ────────────────────────────────────────────

function indexTransaction(
  db: Database.Database,
  tx: Record<string, unknown>,
  meta: Record<string, unknown> | null,
): { account: string; destination: string | null; hasMemo: boolean; alreadyIndexed: boolean } | null {
  const t = (tx as Record<string, unknown>);
  const txHash = (t.hash ?? t.Hash ?? "") as string;
  if (!txHash) return null;

  const account = (t.Account ?? "") as string;
  const destination = (t.Destination ?? null) as string | null;

  // Check if already indexed — but still return metadata so the caller can process edges
  const exists = db.prepare("SELECT 1 FROM transactions WHERE tx_hash = ?").get(txHash);
  if (exists) {
    const memos = (t.Memos ?? []) as unknown[];
    const hasMemo = memos.length > 0;
    return { account, destination, hasMemo, alreadyIndexed: true };
  }

  const txType = (t.TransactionType ?? "") as string;
  const amountDrops = typeof t.Amount === "string" ? t.Amount : "0";
  const feeDrops = (t.Fee ?? "0") as string;
  const ledgerIndex = (t.ledger_index ?? t.inLedger ?? 0) as number;
  const date = (t.date ?? 0) as number;
  const timestampIso = date > 0 ? rippleTimeToISO(date) : "";

  const memos = (t.Memos ?? []) as unknown[];
  const hasMemo = memos.length > 0;
  const parsed = hasMemo ? parseMemo(memos) : null;

  db.prepare(`
    INSERT OR IGNORE INTO transactions
    (tx_hash, ledger_index, tx_type, account, destination, amount_drops, fee_drops,
     timestamp_ripple, timestamp_iso, has_memo, memo_type, memo_data_preview, memo_cid, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    txHash, ledgerIndex, txType, account, destination, amountDrops, feeDrops,
    date, timestampIso, hasMemo ? 1 : 0,
    parsed?.memoType ?? null,
    parsed?.memoData?.substring(0, 200) ?? null,
    parsed?.cid ?? null,
    JSON.stringify(t),
  );

  return { account, destination, hasMemo, alreadyIndexed: false };
}

// ─── Edge Tracking ───────────────────────────────────────────────────

function upsertEdge(
  db: Database.Database,
  from: string,
  to: string,
  hasMemo: boolean,
  amountDrops: string,
  timestamp: string,
): void {
  db.prepare(`
    INSERT INTO edges (from_address, to_address, tx_count, memo_tx_count, total_amount_drops, first_seen, last_seen)
    VALUES (?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(from_address, to_address) DO UPDATE SET
      tx_count = tx_count + 1,
      memo_tx_count = memo_tx_count + ?,
      total_amount_drops = CAST(CAST(total_amount_drops AS INTEGER) + CAST(? AS INTEGER) AS TEXT),
      last_seen = MAX(last_seen, ?)
  `).run(
    from, to, hasMemo ? 1 : 0, amountDrops, timestamp, timestamp,
    hasMemo ? 1 : 0, amountDrops, timestamp,
  );
}

// ─── Account Discovery ──────────────────────────────────────────────

function ensureAccount(db: Database.Database, address: string, ledgerIndex: number, now: string, depth: number): void {
  const exists = db.prepare("SELECT 1 FROM accounts WHERE address = ?").get(address);
  if (!exists) {
    db.prepare(`
      INSERT INTO accounts (address, first_seen_ledger, last_seen_ledger, discovered_at, crawl_depth)
      VALUES (?, ?, ?, ?, ?)
    `).run(address, ledgerIndex, ledgerIndex, now, depth);
  } else {
    db.prepare(`
      UPDATE accounts SET last_seen_ledger = MAX(last_seen_ledger, ?) WHERE address = ?
    `).run(ledgerIndex, address);
  }
}

// ─── Main Crawler ────────────────────────────────────────────────────

export interface CrawlResult {
  accountsCrawled: number;
  accountsDiscovered: number;
  transactionsIndexed: number;
  memoTransactions: number;
  edgesCreated: number;
}

export async function crawl(
  db: Database.Database,
  seedAccounts: string[],
  config: CrawlerConfig = DEFAULT_CONFIG,
): Promise<CrawlResult> {
  const now = new Date().toISOString();
  const result: CrawlResult = {
    accountsCrawled: 0,
    accountsDiscovered: 0,
    transactionsIndexed: 0,
    memoTransactions: 0,
    edgesCreated: 0,
  };

  // Ensure seeds are in the DB
  for (const seed of seedAccounts) {
    ensureAccount(db, seed, 0, now, 0);
  }

  // BFS crawl
  let queue = [...seedAccounts];
  let depth = 0;

  while (queue.length > 0 && depth <= config.maxDepth) {
    const nextQueue: string[] = [];
    console.log(`[crawl] Depth ${depth}: ${queue.length} accounts`);

    for (const account of queue) {
      // Check if already crawled this run
      const acctRow = db.prepare("SELECT last_crawled_at FROM accounts WHERE address = ?").get(account) as { last_crawled_at: string | null } | undefined;
      if (acctRow?.last_crawled_at === now) continue;

      console.log(`  [crawl] ${account.substring(0, 15)}...`);
      const txns = await getAllAccountTx(config.rpcUrl, account, config.txLimitPerAccount, config.rateLimitMs);

      let txCount = 0;
      let memoCount = 0;
      const newCounterparties = new Set<string>();

      const insertMany = db.transaction(() => {
        for (const rawTx of txns) {
          const tx = (rawTx as Record<string, unknown>).tx_json ?? (rawTx as Record<string, unknown>).tx ?? rawTx;
          const meta = (rawTx as Record<string, unknown>).meta as Record<string, unknown> | null;
          const t = tx as Record<string, unknown>;

          const indexed = indexTransaction(db, t, meta);
          if (!indexed) continue;

          txCount++;
          if (indexed.hasMemo) memoCount++;

          const ledgerIdx = (t.ledger_index ?? t.inLedger ?? 0) as number;
          const date = (t.date ?? 0) as number;
          const ts = date > 0 ? rippleTimeToISO(date) : now;
          const amount = typeof t.Amount === "string" ? t.Amount : "0";

          // Track counterparties and edges — ALWAYS run this, even for already-indexed txns.
          // Previously edges were only created when a transaction was first indexed, which
          // meant re-crawling or crawling in a different order left edges missing.
          if (indexed.destination && indexed.destination !== account) {
            ensureAccount(db, indexed.destination, ledgerIdx, now, depth + 1);
            newCounterparties.add(indexed.destination);
            // Only upsert edge if this was a newly-indexed tx OR if the edge doesn't exist yet
            if (!indexed.alreadyIndexed) {
              upsertEdge(db, indexed.account, indexed.destination, indexed.hasMemo, amount, ts);
            } else {
              // Ensure edge exists even if tx was already indexed (fixes gaps from earlier bug)
              const edgeExists = db.prepare(
                "SELECT 1 FROM edges WHERE from_address = ? AND to_address = ? LIMIT 1"
              ).get(indexed.account, indexed.destination);
              if (!edgeExists) {
                upsertEdge(db, indexed.account, indexed.destination, indexed.hasMemo, amount, ts);
              }
            }
          }
          if (indexed.account !== account) {
            ensureAccount(db, indexed.account, ledgerIdx, now, depth + 1);
            newCounterparties.add(indexed.account);
          }
        }

        // Update account stats
        db.prepare(`
          UPDATE accounts SET
            tx_count = ?, memo_tx_count = ?, last_crawled_at = ?, crawl_depth = MIN(crawl_depth, ?)
          WHERE address = ?
        `).run(txCount, memoCount, now, depth, account);
      });

      insertMany();

      result.accountsCrawled++;
      result.transactionsIndexed += txCount;
      result.memoTransactions += memoCount;
      result.accountsDiscovered += newCounterparties.size;

      // Queue new counterparties for next depth
      for (const cp of newCounterparties) {
        const cpRow = db.prepare("SELECT last_crawled_at FROM accounts WHERE address = ?").get(cp) as { last_crawled_at: string | null } | undefined;
        if (!cpRow?.last_crawled_at) {
          nextQueue.push(cp);
        }
      }

      await sleep(config.rateLimitMs);
    }

    queue = [...new Set(nextQueue)];
    depth++;
  }

  setCrawlState(db, "last_crawl_at", now);
  setCrawlState(db, "last_crawl_accounts", String(result.accountsCrawled));
  setCrawlState(db, "last_crawl_txns", String(result.transactionsIndexed));

  return result;
}
