/**
 * SUBS Bot — On-chain subscription protocol bot
 *
 * Listens for memos at the SUBS protocol address and responds to:
 *   /services  — list available services
 *   /status    — caller's subscription status
 *   /subscribe — process subscription payment
 *   /help      — usage guide
 *
 * Uses the same chain communication layer as the Scout bot.
 */

import { initBotKeys, scanInbound, sendReply, type ChainConfig } from "./chain.js";
import { getPendingFollowups, markContacted, getFollowupMessage, getEffectivePrice } from "./subs-followup.js";
import { execSync } from "child_process";
import sqlite3 from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";

// ─── Config ─────────────────────────────────────────────────────────

const SUBS_SEED = process.env.SUBS_SEED ?? "";
const PFTL_RPC = process.env.PFTL_RPC_URL ?? "http://127.0.0.1:5015";
const POLL_MS = parseInt(process.env.SUBS_POLL_MS ?? "30000");
const DB_PATH = process.env.INDEXER_DB_PATH ?? path.join(os.homedir(), ".pf-scout", "chain-index.db");
const SUBS_JSON = path.join(os.homedir(), "pft-validator", "lens", "subs.json");

const CHAIN_CONFIG: ChainConfig = {
  pftlRpcUrl: PFTL_RPC,
  pftlWssUrl: process.env.XRPL_SERVER ?? "wss://ws.testnet.postfiat.org",
  ipfsGatewayUrl: process.env.IPFS_GATEWAY_URL ?? "https://ipfs-testnet.postfiat.org",
  keystoneGrpcUrl: process.env.KEYSTONE_GRPC_URL ?? "keystone-grpc.postfiat.org:443",
  keystoneApiKey: process.env.KEYSTONE_API_KEY ?? "",
  tasknodeEncryptionPubkey: process.env.TASKNODE_ENCRYPTION_PUBKEY ?? "",
};

// ─── Registry ───────────────────────────────────────────────────────

interface ServiceEntry {
  service_id: string;
  name: string;
  price_pft: number;
  price_drops: number;
  period_days: number;
  description: string;
  status: string;
  subscribers_active: number;
  features: string[];
  free_features: string[];
}

function loadRegistry(): { services: ServiceEntry[]; protocol_address: string } {
  try {
    const data = JSON.parse(fs.readFileSync(SUBS_JSON, "utf-8"));
    return data;
  } catch {
    return { services: [], protocol_address: "" };
  }
}

// ─── Command Handlers ───────────────────────────────────────────────

function handleServices(): string {
  const reg = loadRegistry();
  const services = reg.services.filter(s => s.status === "active");

  if (services.length === 0) {
    return "SUBS — No services available yet.\nBe the first to register.";
  }

  const lines = services.map((s, i) => {
    return `${i + 1}. ${s.name} [${s.service_id}] — ${s.price_pft} PFT/${s.period_days}d\n   ${s.description}\n   ${s.subscribers_active} subscribers\n   /subscribe ${s.service_id}`;
  });

  return `SUBS — ${services.length} service(s):\n\n${lines.join("\n\n")}\n\nSend /status to check your subscriptions.`;
}

function handleStatus(sender: string): string {
  const reg = loadRegistry();
  const protocolAddr = reg.protocol_address;

  let db: sqlite3.Database;
  try {
    db = new sqlite3(DB_PATH, { readonly: true });
    db.pragma("journal_mode = WAL");
  } catch {
    return "Unable to check subscription status. Index not available.";
  }

  try {
    const results: string[] = [];

    for (const svc of reg.services) {
      // Check for subscription payments. Accept both full price and discounted price.
      const pricing = getEffectivePrice(sender);
      const minPrice = Math.min(svc.price_drops, pricing.price_drops);
      const row = db.prepare(`
        SELECT tx_hash, timestamp_iso, CAST(amount_drops AS INTEGER) as amount_drops
        FROM transactions
        WHERE destination = ?
          AND account = ?
          AND CAST(amount_drops AS INTEGER) >= ?
          AND tx_type = 'Payment'
        ORDER BY timestamp_iso DESC
        LIMIT 1
      `).get(
        protocolAddr, sender, minPrice
      ) as { tx_hash: string; timestamp_iso: string; amount_drops: number } | undefined;

      if (!row) continue;

      const paymentTime = new Date(row.timestamp_iso);
      const expiresAt = new Date(paymentTime);
      expiresAt.setDate(expiresAt.getDate() + svc.period_days);
      const now = new Date();

      let state: string;
      if (now >= expiresAt) {
        state = "EXPIRED";
      } else {
        const graceThreshold = new Date(expiresAt);
        graceThreshold.setHours(graceThreshold.getHours() - 72);
        state = now >= graceThreshold ? "EXPIRING" : "ACTIVE";
      }

      const expiryStr = expiresAt.toISOString().substring(0, 10);
      results.push(`${svc.name}: ${state} (expires ${expiryStr})`);
    }

    if (results.length === 0) {
      return `No active subscriptions for ${sender.substring(0, 6) + "..." + sender.substring(sender.length - 4)}...\n\nSend /services to browse available services.`;
    }

    return `Your subscriptions:\n${results.join("\n")}`;
  } finally {
    db.close();
  }
}

function handleHelp(): string {
  return (
    "SUBS — On-chain service marketplace\n\n" +
    "Commands:\n" +
    "  /services    Browse available services\n" +
    "  /status      Your subscription status\n" +
    "  /subscribe <id>  Subscribe (send with PFT)\n" +
    "  /help        This message\n\n" +
    "Browse: pft.permanentupperclass.com/subs/\n" +
    "Spec: github.com/P-U-C/pft-validator/blob/main/subs-protocol.md"
  );
}

function parseCommand(content: string): { cmd: string; args: string } {
  const trimmed = content.trim();
  const lower = trimmed.toLowerCase();

  if (lower.startsWith("/services") || lower === "services") {
    return { cmd: "services", args: "" };
  }
  if (lower.startsWith("/status") || lower === "status") {
    return { cmd: "status", args: "" };
  }
  if (lower.startsWith("/subscribe")) {
    return { cmd: "subscribe", args: trimmed.substring(10).trim() };
  }
  if (lower.startsWith("/help") || lower === "help" || lower === "?") {
    return { cmd: "help", args: "" };
  }

  // Default: show help
  return { cmd: "help", args: "" };
}

// ─── Subscribe Handler ──────────────────────────────────────────────

function handleSubscribe(sender: string, serviceId: string, amountDrops: string): string {
  const reg = loadRegistry();
  const service = reg.services.find(s => s.service_id === serviceId.toLowerCase());

  if (!service) {
    const available = reg.services.map(s => s.service_id).join(', ');
    return `Service "${serviceId}" not found. Available: ${available || 'none'}`;
  }

  if (service.status !== 'active') {
    return `Service "${service.name}" is currently ${service.status}. Cannot subscribe.`;
  }

  const paidDrops = parseInt(amountDrops, 10) || 0;
  const paidPft = paidDrops / 1_000_000;

  // Check for active discount
  const pricing = getEffectivePrice(sender);
  const requiredDrops = pricing.price_drops;
  const requiredPft = pricing.price_pft;

  // Check if they sent enough PFT with this message
  if (paidDrops >= requiredDrops) {
    // Payment received! Activate subscription
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + service.period_days);
    const expiryStr = expiresAt.toISOString().substring(0, 10);

    console.log(`  [subs] SUBSCRIPTION ACTIVATED: ${sender.substring(0, 15)}... -> ${service.service_id} (${paidPft} PFT, expires ${expiryStr})`);

    return `Subscribed to ${service.name}!\n\nActive until: ${expiryStr}\nPaid: ${paidPft} PFT\n\nYou will receive the daily Herald to your inbox.\nRead online: pft.permanentupperclass.com/herald/`;
  }

  // Not enough PFT attached — give clear instructions
  const priceNote = pricing.discounted ? ` (discounted from ${service.price_pft} PFT!)` : '';

  if (paidDrops > 0 && paidDrops < requiredDrops) {
    return `Almost! You sent ${paidPft} PFT but ${service.name} costs ${requiredPft} PFT${priceNote}.\n\nTo subscribe: change the PFT amount at the bottom of the chat to ${requiredPft}, type /subscribe ${service.service_id}, then hit Send.`;
  }

  return `${service.name} — ${requiredPft} PFT for ${service.period_days} days${priceNote}.\n\nTo subscribe:\n1. Change the PFT amount at the bottom of the chat to ${requiredPft}\n2. Type /subscribe ${service.service_id}\n3. Hit Send\n\nYour subscription activates immediately.\npft.permanentupperclass.com/herald/`;
}

// ─── Process Incoming Subscription Payments ─────────────────────────

const SUBS_EXPORT_SCRIPT = path.join(os.homedir(), "pf-scout-bot", "deploy", "export-subs.sh");
const seenSubscriptions = new Set<string>();

function checkNewSubscriptions(): void {
  const reg = loadRegistry();
  const protocolAddr = reg.protocol_address || '';
  if (!protocolAddr) return;

  let db: sqlite3.Database;
  try {
    db = new sqlite3(DB_PATH, { readonly: true });
    db.pragma("journal_mode = WAL");
  } catch { return; }

  let foundNew = false;

  try {
    // Find subscription payments -- match on amount, not memo type
    // (task node encrypts all memos as keystone envelopes)
    const payments = db.prepare(`
      SELECT tx_hash, account, timestamp_iso,
             CAST(amount_drops AS INTEGER) as amount_drops
      FROM transactions
      WHERE destination = ?
        AND tx_type = 'Payment'
        AND CAST(amount_drops AS INTEGER) >= ?
        AND timestamp_iso > datetime('now', '-1 hours')
      ORDER BY timestamp_iso DESC
    `).all(protocolAddr, reg.services[0]?.price_drops ?? 1000000000) as {
      tx_hash: string; account: string; timestamp_iso: string;
      amount_drops: number;
    }[];

    for (const p of payments) {
      const service = reg.services[0];
      if (!service) continue;
      if (p.amount_drops < service.price_drops) continue;

      // Skip if we've already seen this subscription
      const key = `${p.account}:${p.tx_hash}`;
      if (seenSubscriptions.has(key)) continue;
      seenSubscriptions.add(key);

      const pft = p.amount_drops / 1_000_000;
      const expiresAt = new Date(p.timestamp_iso);
      expiresAt.setDate(expiresAt.getDate() + service.period_days);

      console.log(`  [subs] New subscription: ${p.account.substring(0, 15)}... -> ${service.service_id} (${pft} PFT, expires ${expiresAt.toISOString().substring(0, 10)})`);
      foundNew = true;
    }
  } finally {
    db.close();
  }

  // Re-export subs.json so the website updates immediately
  if (foundNew) {
    try {
      console.log("  [subs] New subscription detected -- re-exporting subs.json...");
      execSync(`bash ${SUBS_EXPORT_SCRIPT}`, { timeout: 30000, stdio: "pipe" });
      console.log("  [subs] subs.json re-exported and pushed.");
    } catch (err) {
      console.error("  [subs] Failed to re-export subs.json:", (err as Error).message?.substring(0, 80));
    }
  }
}

// ─── Main Loop ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!SUBS_SEED) {
    console.error("ERROR: SUBS_SEED env var required.");
    process.exit(1);
  }

  console.log("Initializing SUBS bot keys...");
  const botKeys = await initBotKeys(SUBS_SEED);
  console.log(`SUBS bot running as ${botKeys.address}`);
  console.log(`Polling every ${POLL_MS / 1000}s`);
  console.log(`RPC: ${PFTL_RPC}`);

  let sinceLedger: number | undefined;

  // Persist processed tx hashes to disk so restarts don't replay
  const PROCESSED_FILE = path.join(os.homedir(), '.pf-scout', 'subs-bot-processed.json');
  let processedTxHashes: Set<string>;
  try {
    const saved = JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf-8'));
    processedTxHashes = new Set(saved);
    console.log(`Loaded ${processedTxHashes.size} processed tx hashes from disk`);
  } catch {
    processedTxHashes = new Set();
  }

  function saveProcessed() {
    try {
      // Keep only last 500 to prevent unbounded growth
      const arr = [...processedTxHashes].slice(-500);
      fs.writeFileSync(PROCESSED_FILE, JSON.stringify(arr));
    } catch {}
  }

  let running = true;
  process.on("SIGINT", () => { saveProcessed(); running = false; process.exit(0); });
  process.on("SIGTERM", () => { saveProcessed(); running = false; process.exit(0); });

  while (running) {
    try {
      const { messages, nextLedger } = await scanInbound(CHAIN_CONFIG, botKeys, sinceLedger);

      if (nextLedger > (sinceLedger ?? 0)) {
        sinceLedger = nextLedger + 1;
      }

      // Count genuinely new messages
      const newMessages = messages.filter(m => m.sender !== botKeys.address && m.txHash && !processedTxHashes.has(m.txHash));

      if (newMessages.length > 0) {
        console.log(`[${new Date().toISOString()}] ${newMessages.length} new message(s) (${messages.length} total scanned)`);
      }

      for (const msg of messages) {
        if (msg.sender === botKeys.address) continue;
        if (msg.txHash && processedTxHashes.has(msg.txHash)) continue;
        if (msg.txHash) processedTxHashes.add(msg.txHash);

        console.log(`  <- ${msg.sender.substring(0, 15)}... : ${msg.content.substring(0, 60)}`);

        try {
          const { cmd } = parseCommand(msg.content);
          let response: string;

          switch (cmd) {
            case "services":
              response = handleServices();
              break;
            case "status":
              response = handleStatus(msg.sender);
              break;
            case "subscribe": {
              const { args } = parseCommand(msg.content);
              response = handleSubscribe(msg.sender, args || "herald", msg.amountDrops);
              break;
            }
            default:
              response = handleHelp();
          }

          const txHash = await sendReply(CHAIN_CONFIG, botKeys, msg.sender, response, SUBS_SEED);
          console.log(`  -> ${msg.sender.substring(0, 15)}... (${cmd}, tx: ${txHash.substring(0, 16)}...)`);
        } catch (err) {
          console.error(`  ! Error:`, err);
          try {
            await sendReply(CHAIN_CONFIG, botKeys, msg.sender, "Error processing your request. Try /help.", SUBS_SEED);
          } catch { }
        }
      }
      // Check for new subscription payments
      checkNewSubscriptions();

      // Send follow-up offers to interested non-subscribers (every poll cycle, cheap check)
      try {
        const pending = getPendingFollowups();
        for (const candidate of pending) {
          console.log(`  [followup] Sending offer to ${candidate.address.substring(0, 15)}... (interacted ${candidate.days_since} days ago)`);
          const offerMsg = getFollowupMessage();
          await sendReply(CHAIN_CONFIG, botKeys, candidate.address, offerMsg, SUBS_SEED);
          markContacted(candidate.address);
          console.log(`  [followup] Offer sent to ${candidate.address.substring(0, 15)}...`);
        }
      } catch (err) {
        console.error(`  [followup] Error:`, err);
      }

      // Persist processed hashes
      saveProcessed();
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Poll error:`, err);
    }

    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
