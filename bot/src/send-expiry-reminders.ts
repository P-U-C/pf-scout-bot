/**
 * send-expiry-reminders.ts — daily on-chain reminder for subscribers
 * whose 30-day Herald window expires in 1-3 days.
 *
 * Gate: chain Payment >=1000 PFT to SUBS protocol within last 30d,
 * with 1 <= days_remaining <= REMINDER_WINDOW_DAYS.
 *
 * Dedup: ~/.pf-scout/reminder-log.json tracks {address: cycle_start_date}.
 * One reminder per 30-day window. Re-arms after subscriber renews
 * (new payment timestamp -> different cycle key).
 */

import fs from "fs";
import path from "path";
import os from "os";
import sqlite3 from "better-sqlite3";
import { initBotKeys, sendReply } from "./chain.js";

const DB_PATH = path.join(os.homedir(), ".pf-scout", "chain-index.db");
const REMINDER_LOG = path.join(os.homedir(), ".pf-scout", "reminder-log.json");
const SUBS_ADDRESS = "r9XYDxJDbmmhSGNpUguVhea6xn3Tu2HbeF";
const PRICE_DROPS = 1_000_000_000;
const PERIOD_DAYS = 30;
const REMINDER_WINDOW_DAYS = 3;

const CHAIN_CONFIG = {
  pftlRpcUrl: process.env.PFTL_RPC_URL ?? "http://127.0.0.1:5015",
  pftlWssUrl: process.env.XRPL_SERVER ?? "wss://ws.testnet.postfiat.org",
  ipfsGatewayUrl: "https://ipfs-testnet.postfiat.org",
  keystoneGrpcUrl: "keystone-grpc.postfiat.org:443",
  keystoneApiKey: process.env.KEYSTONE_API_KEY ?? "",
  tasknodeEncryptionPubkey: process.env.TASKNODE_ENCRYPTION_PUBKEY ?? "",
};

interface ReminderLog { [address: string]: string }

function loadLog(): ReminderLog {
  try { return JSON.parse(fs.readFileSync(REMINDER_LOG, "utf-8")); } catch { return {}; }
}

function saveLog(log: ReminderLog): void {
  fs.writeFileSync(REMINDER_LOG, JSON.stringify(log, null, 2));
}

async function main(): Promise<void> {
  const subsSeed = process.env.SUBS_SEED;
  if (!subsSeed) {
    console.error("SUBS_SEED env var is required");
    process.exit(1);
  }

  const db = new sqlite3(DB_PATH, { readonly: true });
  db.pragma("journal_mode = WAL");

  const rows = db.prepare(`
    SELECT account, MAX(timestamp_iso) as last_payment
    FROM transactions
    WHERE destination = ?
      AND CAST(amount_drops AS INTEGER) >= ?
      AND CAST(amount_drops AS INTEGER) < ?
      AND tx_type = 'Payment'
      AND account != ?
      AND timestamp_iso > datetime('now', '-${PERIOD_DAYS} days')
    GROUP BY account
  `).all(SUBS_ADDRESS, PRICE_DROPS, PRICE_DROPS + 1_000_000, SUBS_ADDRESS) as
    { account: string; last_payment: string }[];

  db.close();

  const now = Date.now();
  const log = loadLog();
  const toRemind: { addr: string; daysLeft: number; expiresAt: string; cycleKey: string }[] = [];

  for (const r of rows) {
    // timestamp_iso already ends in Z; don't double-append.
    const isoLast = r.last_payment.endsWith("Z") ? r.last_payment : r.last_payment + "Z";
    const last = new Date(isoLast).getTime();
    if (Number.isNaN(last)) {
      console.warn(`  skip ${r.account}: unparseable timestamp ${r.last_payment}`);
      continue;
    }
    const expires = last + PERIOD_DAYS * 86400_000;
    const daysLeft = Math.ceil((expires - now) / 86400_000);
    if (daysLeft < 1 || daysLeft > REMINDER_WINDOW_DAYS) continue;
    // Cycle key = the start of this 30-day window (last payment date).
    // We re-arm reminders when the subscriber renews (new last_payment).
    const cycleKey = r.last_payment.substring(0, 10);
    if ((log[r.account] ?? "") >= cycleKey) continue;
    toRemind.push({
      addr: r.account,
      daysLeft,
      expiresAt: new Date(expires).toISOString().substring(0, 10),
      cycleKey,
    });
  }

  console.log(`Subscribers in reminder window (1-${REMINDER_WINDOW_DAYS}d): ${toRemind.length}`);
  for (const r of toRemind) {
    console.log(`  ${r.addr.substring(0, 15)}...  expires ${r.expiresAt} (${r.daysLeft}d, cycle=${r.cycleKey})`);
  }

  if (toRemind.length === 0) return;

  if (process.env.DRY_RUN === "1") {
    console.log("DRY_RUN=1; not sending");
    return;
  }

  const botKeys = await initBotKeys(subsSeed);
  console.log(`Sender: ${botKeys.address}`);

  let sent = 0;
  for (const r of toRemind) {
    const plural = r.daysLeft === 1 ? "" : "s";
    const msg = [
      `HERALD SUBSCRIPTION REMINDER`,
      ``,
      `Your Herald subscription expires in ${r.daysLeft} day${plural} (${r.expiresAt} UTC).`,
      ``,
      `To extend for another 30 days: send 1000 PFT to ${SUBS_ADDRESS}`,
      ``,
      `Or do nothing — your subscription will simply lapse.`,
    ].join("\n");

    try {
      await sendReply(CHAIN_CONFIG, botKeys, r.addr, msg, subsSeed);
      console.log(`  reminded -> ${r.addr.substring(0, 15)}... (${r.daysLeft}d)`);
      log[r.addr] = r.cycleKey;
      sent++;
      await new Promise((res) => setTimeout(res, 2000));
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`  FAILED -> ${r.addr}: ${m}`);
    }
  }

  saveLog(log);
  console.log(`Done: ${sent}/${toRemind.length} reminders delivered`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
