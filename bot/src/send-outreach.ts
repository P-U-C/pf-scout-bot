/**
 * Send free trial outreach messages to active contributors.
 * Run once — sends to all qualifying contacts and records in CRM.
 */

import { initBotKeys, sendReply, type ChainConfig } from "./chain.js";
import { loadCRM, saveCRM, addContact, markMessageSent, updateStatuses, generateDailyReport } from "./subs-crm.js";
import sqlite3 from "better-sqlite3";
import path from "path";
import os from "os";

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

const CHAIN_CONFIG: ChainConfig = {
  pftlRpcUrl: process.env.PFTL_RPC_URL ?? "http://127.0.0.1:5015",
  pftlWssUrl: process.env.XRPL_SERVER ?? "wss://ws.testnet.postfiat.org",
  ipfsGatewayUrl: "https://ipfs-testnet.postfiat.org",
  keystoneGrpcUrl: "keystone-grpc.postfiat.org:443",
  keystoneApiKey: process.env.KEYSTONE_API_KEY ?? "",
  tasknodeEncryptionPubkey: process.env.TASKNODE_ENCRYPTION_PUBKEY ?? "",
};

async function main() {
  const botKeys = await initBotKeys(process.env.SUBS_SEED!);
  console.log("Bot address:", botKeys.address);

  const db = new sqlite3(DB_PATH, { readonly: true });
  db.pragma("journal_mode = WAL");

  // Find active contributors who haven't interacted with SUBS
  const subsInteracted = new Set(
    (db.prepare("SELECT DISTINCT account FROM transactions WHERE destination = ?")
      .all(SUBS_ADDRESS) as { account: string }[]).map(r => r.account)
  );

  const activeContributors = db.prepare(`
    SELECT account, COUNT(*) as memos FROM transactions
    WHERE destination = 'rwdm72S9YVKkZjeADKU2bbUMuY4vPnSfH7'
    AND has_memo = 1 AND timestamp_iso > datetime('now', '-30 days')
    AND account NOT IN (SELECT address FROM wallet_labels WHERE label_type IN ('infrastructure','bot'))
    GROUP BY account HAVING memos >= ?
    ORDER BY memos DESC
  `).all(MIN_MEMOS) as { account: string; memos: number }[];

  const targets = activeContributors.filter(c => !subsInteracted.has(c.account));
  console.log(`Targets: ${targets.length} contributors with ${MIN_MEMOS}+ memos who haven't interacted with SUBS`);

  db.close();

  // Load CRM
  const crm = loadCRM();

  // Send messages
  let sent = 0;
  for (const target of targets) {
    // Skip if already in CRM
    if (crm.contacts[target.account]) {
      console.log(`  Skip ${target.account.substring(0, 6)}...${target.account.slice(-4)} (already in CRM)`);
      continue;
    }

    // Add to CRM
    addContact(crm, target.account, target.memos);

    try {
      console.log(`  Sending to ${target.account.substring(0, 6)}...${target.account.slice(-4)} (${target.memos} memos)...`);
      await sendReply(CHAIN_CONFIG, botKeys, target.account, MESSAGE, process.env.SUBS_SEED!);
      markMessageSent(crm, target.account);
      sent++;
      console.log(`  ✓ Sent (${sent}/${targets.length})`);

      // Rate limit: 3 second delay between messages
      await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      console.error(`  ✗ Failed to send to ${target.account.substring(0, 6)}:`, err);
    }

    // Save after each send (crash-safe)
    saveCRM(crm);
  }

  console.log(`\nOutreach complete: ${sent} messages sent`);

  // Generate initial report
  updateStatuses(crm);
  const report = generateDailyReport(crm);
  saveCRM(crm);
  console.log("\n" + report.report_text);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
