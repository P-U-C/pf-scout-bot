/**
 * db.ts — SQLite persistence layer for the PFTL chain indexer.
 *
 * Stores: accounts, transactions, memos, crawl state, sybil clusters.
 * Designed for composable growth — new tables can be added without migration.
 */

import Database from "better-sqlite3";
import path from "path";
import os from "os";

const DEFAULT_DB_PATH = process.env.INDEXER_DB_PATH ??
  path.join(os.homedir(), ".pf-scout", "chain-index.db");

export function openDb(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    -- Discovered accounts
    CREATE TABLE IF NOT EXISTS accounts (
      address TEXT PRIMARY KEY,
      first_seen_ledger INTEGER,
      last_seen_ledger INTEGER,
      tx_count INTEGER DEFAULT 0,
      memo_tx_count INTEGER DEFAULT 0,
      balance_drops TEXT,
      discovered_at TEXT NOT NULL,
      last_crawled_at TEXT,
      crawl_depth INTEGER DEFAULT -1
    );

    -- All indexed transactions
    CREATE TABLE IF NOT EXISTS transactions (
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
    CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account);
    CREATE INDEX IF NOT EXISTS idx_tx_destination ON transactions(destination);
    CREATE INDEX IF NOT EXISTS idx_tx_ledger ON transactions(ledger_index);
    CREATE INDEX IF NOT EXISTS idx_tx_memo ON transactions(has_memo) WHERE has_memo = 1;

    -- Interaction edges (who talks to whom, how much)
    CREATE TABLE IF NOT EXISTS edges (
      from_address TEXT NOT NULL,
      to_address TEXT NOT NULL,
      tx_count INTEGER DEFAULT 0,
      memo_tx_count INTEGER DEFAULT 0,
      total_amount_drops TEXT DEFAULT '0',
      first_seen TEXT,
      last_seen TEXT,
      PRIMARY KEY (from_address, to_address)
    );

    -- Crawl state for resumability
    CREATE TABLE IF NOT EXISTS crawl_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Sybil analysis clusters
    CREATE TABLE IF NOT EXISTS sybil_clusters (
      cluster_id TEXT NOT NULL,
      address TEXT NOT NULL,
      confidence REAL NOT NULL,
      signals TEXT NOT NULL,  -- JSON array of signal types
      detected_at TEXT NOT NULL,
      PRIMARY KEY (cluster_id, address)
    );
    CREATE INDEX IF NOT EXISTS idx_sybil_address ON sybil_clusters(address);
  `);
}

// ─── Crawl State Helpers ──────────────────────────────────────────

export function getCrawlState(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM crawl_state WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setCrawlState(db: Database.Database, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO crawl_state (key, value) VALUES (?, ?)").run(key, value);
}
