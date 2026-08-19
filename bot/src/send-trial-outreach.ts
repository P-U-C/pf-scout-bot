/**
 * send-trial-outreach.ts — one-shot outreach to active contributors who
 * have not yet interacted with the SUBS protocol. Each new contact gets
 * a free 7-day Herald trial and a welcome message.
 *
 * Extracted to a file (from inline bash heredoc) because tsx 4.21+
 * `npx tsx -e` no longer resolves `./src/chain.js` correctly under
 * ESM packages.
 */

import path from "path";
import os from "os";
import sqlite3 from "better-sqlite3";
import { initBotKeys, sendReply } from "./chain.js";
import {
  loadCRM,
  saveCRM,
  addContact,
  markMessageSent,
  updateStatuses,
  generateDailyReport,
} from "./subs-crm.js";

const DB_PATH = path.join(os.homedir(), ".pf-scout", "chain-index.db");
const SUBS_ADDRESS = "r9XYDxJDbmmhSGNpUguVhea6xn3Tu2HbeF";
const MIN_MEMOS = 50;

const MESSAGE = `You've been one of the most active contributors on the Post Fiat task node. As a thank you, you've received a free 7-day trial of The Hive Herald — a daily on-chain intelligence briefing.

What you'll get each day:
• Who earned the most PFT today
• Daily airdrop recipients and amounts
• Network health and velocity trends
• Sybil detection updates

Your trial is active now. Tomorrow's edition arrives at 00:05 UTC.

Read today's edition: pft.permanentupperclass.com/herald/`;

const CHAIN_CONFIG = {
  pftlRpcUrl: process.env.PFTL_RPC_URL ?? "http://127.0.0.1:5015",
  pftlWssUrl: process.env.XRPL_SERVER ?? "wss://ws.testnet.postfiat.org",
  ipfsGatewayUrl: "https://ipfs-testnet.postfiat.org",
  keystoneGrpcUrl: "keystone-grpc.postfiat.org:443",
  keystoneApiKey: process.env.KEYSTONE_API_KEY ?? "",
  tasknodeEncryptionPubkey: process.env.TASKNODE_ENCRYPTION_PUBKEY ?? "",
};

async function main(): Promise<void> {
  const subsSeed = process.env.SUBS_SEED;
  if (!subsSeed) {
    console.error("SUBS_SEED env var is required");
    process.exit(1);
  }

  const botKeys = await initBotKeys(subsSeed);
  console.log("Bot address:", botKeys.address);

  const db = new sqlite3(DB_PATH, { readonly: true });
  db.pragma("journal_mode = WAL");

  const subsInteracted = new Set(
    (db
      .prepare("SELECT DISTINCT account FROM transactions WHERE destination = ?")
      .all(SUBS_ADDRESS) as { account: string }[]).map((r) => r.account),
  );

  const activeContributors = db
    .prepare(
      `
    SELECT account, COUNT(*) as memos FROM transactions
    WHERE destination = 'rwdm72S9YVKkZjeADKU2bbUMuY4vPnSfH7'
      AND has_memo = 1
      AND timestamp_iso > datetime('now', '-30 days')
      AND account NOT IN (SELECT address FROM wallet_labels WHERE label_type IN ('infrastructure','bot'))
    GROUP BY account HAVING memos >= ?
    ORDER BY memos DESC
  `,
    )
    .all(MIN_MEMOS) as { account: string; memos: number }[];

  const targets = activeContributors.filter((c) => !subsInteracted.has(c.account));
  console.log(
    `Targets: ${targets.length} contributors with ${MIN_MEMOS}+ memos who haven't interacted with SUBS`,
  );

  db.close();

  const crm = loadCRM();
  const dryRun = process.env.DRY_RUN === "1";
  if (dryRun) console.log("DRY_RUN=1; not sending");

  let sent = 0;
  for (const target of targets) {
    if (crm.contacts[target.account]) {
      console.log(`  Skip ${target.account.substring(0, 6)}...${target.account.slice(-4)} (already in CRM)`);
      continue;
    }
    addContact(crm, target.account, target.memos);

    if (dryRun) {
      console.log(`  WOULD send → ${target.account.substring(0, 6)}...${target.account.slice(-4)} (${target.memos} memos)`);
      continue;
    }

    try {
      console.log(`  Sending to ${target.account.substring(0, 6)}...${target.account.slice(-4)} (${target.memos} memos)...`);
      await sendReply(CHAIN_CONFIG, botKeys, target.account, MESSAGE, subsSeed);
      markMessageSent(crm, target.account);
      sent++;
      console.log(`  ✓ Sent (${sent}/${targets.length})`);
      await new Promise((r) => setTimeout(r, 3000));
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ Failed to send to ${target.account.substring(0, 6)}: ${m}`);
    }

    // Crash-safe: save after each send
    saveCRM(crm);
  }

  console.log(`\nOutreach complete: ${sent} messages sent`);

  updateStatuses(crm);
  const report = generateDailyReport(crm);
  saveCRM(crm);
  console.log("\n" + report.report_text);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
