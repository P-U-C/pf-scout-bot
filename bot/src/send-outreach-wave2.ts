/**
 * Wave 2 outreach: free Herald trial + feedback request
 * Targets airdrop recipients not in CRM and not interacted with SUBS
 */

import { initBotKeys, sendReply, type ChainConfig } from "./chain.js";
import { loadCRM, saveCRM, addContact, markMessageSent } from "./subs-crm.js";
import sqlite3 from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";

const DB_PATH = path.join(os.homedir(), ".pf-scout", "chain-index.db");
const SUBS_ADDRESS = "r9XYDxJDbmmhSGNpUguVhea6xn3Tu2HbeF";

const MESSAGE = `You've been earning rewards on the Post Fiat task node — nice work. We'd like to offer you a free 7-day trial of The Hive Herald, a daily on-chain intelligence briefing.

What you'll get each day:
- Who earned the most PFT today
- Daily airdrop recipients and amounts
- Network health and velocity trends
- Fastest growing new contributors

Your trial is active now. Tomorrow's edition arrives at 00:05 UTC.

Read today's edition: pft.permanentupperclass.com/herald/

We're building this for contributors like you — we'd love your feedback. What's useful? What's missing? Reply anytime.`;

const CHAIN_CONFIG: ChainConfig = {
  pftlRpcUrl: process.env.PFTL_RPC_URL ?? "http://127.0.0.1:5015",
  pftlWssUrl: process.env.XRPL_SERVER ?? "wss://ws.testnet.postfiat.org",
  ipfsGatewayUrl: "https://ipfs-testnet.postfiat.org",
  keystoneGrpcUrl: "keystone-grpc.postfiat.org:443",
  keystoneApiKey: process.env.KEYSTONE_API_KEY ?? "",
  tasknodeEncryptionPubkey: process.env.TASKNODE_ENCRYPTION_PUBKEY ?? "",
};

const TARGETS = [
  "r4ahFvpMuDHfjsc8kuECSTTQNbFPaw5XyU",
  "rpc9FcxtaNVdWonAXv3rABecNLx7kcA3sY",
  "rKZAv7namwdt6RGK3cZ31KpV997sB5D6xU",
  "rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx",
  "rs5gToNMtNDsbTdpj85tdrtGukXzc2VF97",
  "r4KJsXArTmVMpeumNMESZGMKYs9z1w8oj3",
  "rwwuYnnm5pouV5FCF24bU7c98dvg4skbyf",
  "r4XLZKYK63z4zW8ttKzgy8NVW1Noa1pRwj",
  "rKZ9SVg1z764ABrLQ3Q1Dh5PPR7gM1z4Df",
  "rJoXbqLJtsjA7HSEP1KaGEfcKiS8Vv2zsb",
  "rBTYXwQofjJraScghrzt9CUHCa1gzUxknC",
  "rs5hbB6HCiYSonfz5Dtxi6yKQupZLMwcZQ",
  "rnzG62usqhnVekGBWbKHPx8TA9ihrrhQYq",
  "rKPoW95tMpPHRgAcSxbvjgNUg8LefhiXp3",
  "rGqvorV7d6daE1wPx1TvLXNTQpBaxvQM7H",
  "rMDeEK6SHXGJbuHQSKQq2aTkKCJ9ErsQTP",
  "rMMKYEp5wn9Rcbz6UfG5WV1jeZZk3gLkWx",
  "r9iMgX4eaYRaTuR8dfccwoLJXdS8iMM2SB",
  "rE5hmYxot7x7zy75oz1ASi296SZeXDv9FG",
  "rpUrELqtXQNS4eLcZk41MK2B75Frit5nA7",
  "rnY4pJVsCBxMavycgZJ2MZobBQdRLAd4Ry",
  "rn6dU8B2yCwyiwPMhZbqCw6mCk8dgF97Pb",
  "rhYD2UEmfDAMVJc1G4y65Y9MXU4FRqcchk",
  "rfaTRV31Vr62rtehp6MLcnEx3M9MB4q4e2",
  "rfDSRg4arm4ZC755o7PwRfXFfm1fEciy5",
  "ratBy2NriiJDWDtoFUrHiiaotMbXZyDRTd",
  "rP1GfG56V6kaEV1zG4Tm7GYaF8utUjM2VS",
  "rNxNH5MoAobNfqfEA2yM1KhFh5znoVZzC",
  "rMStPq9b2BmcYgvuaWr8r2VWqCQZBGx4bQ",
  "rLQUvJB37wkAWKnxhdzBMrHu3m87GYePLr",
  "rKhZWqDxbSPASrR27hra4FeZPiroyrQx6J",
  "rEu2hcu4xZfGmxJn1RwFo8rJw43owEjRAZ",
  "rEmUgGcrKVuiDbho4QYBuA9FzF9sSgeFSe",
  "rBaa4TMYaQCmWkeV81EHUhknmKdqsLe6Cx",
  "rBPFDnCDGyxq7aHYKmnUgMp1ofK63fBQN5",
];

async function main() {
  const botKeys = await initBotKeys(process.env.SUBS_SEED!);
  console.log("Bot address:", botKeys.address);

  const db = new sqlite3(DB_PATH, { readonly: true });
  db.pragma("journal_mode = WAL");

  const crm = loadCRM();
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const address of TARGETS) {
    if (crm.contacts[address]) {
      console.log(`  Skip ${address.substring(0, 8)}...${address.slice(-4)} (already in CRM)`);
      skipped++;
      continue;
    }

    // Get memo count
    const row = db.prepare("SELECT memo_tx_count FROM accounts WHERE address = ?").get(address) as { memo_tx_count: number } | undefined;
    const memos = row?.memo_tx_count ?? 0;

    addContact(crm, address, memos);

    try {
      console.log(`  Sending to ${address.substring(0, 8)}...${address.slice(-4)} (${memos} memos)...`);
      await sendReply(CHAIN_CONFIG, botKeys, address, MESSAGE, process.env.SUBS_SEED!);
      markMessageSent(crm, address);
      sent++;
      console.log(`  ✓ Sent (${sent}/${TARGETS.length})`);
      await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      console.error(`  ✗ Failed:`, (err as Error).message?.substring(0, 80));
      failed++;
    }

    saveCRM(crm);
  }

  db.close();
  console.log(`\nWave 2 complete: ${sent} sent, ${skipped} skipped, ${failed} failed`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
