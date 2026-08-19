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

import { initBotKeys, scanInbound, sendReply, type ChainConfig } from "../../bot/src/chain.js";
import sqlite3 from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";

// ─── Config ─────────────────────────────────────────────────────────

const SUBS_SEED = process.env.SUBS_SEED ?? "";
const PFTL_RPC = process.env.PFTL_RPC_URL ?? "http://127.0.0.1:5015";
const POLL_MS = parseInt(process.env.SUBS_POLL_MS ?? "60000");
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
    return `${i + 1}. ${s.name} — ${s.price_pft} PFT/${s.period_days}d\n   ${s.description}\n   ${s.subscribers_active} subscribers`;
  });

  return `SUBS — ${services.length} service(s):\n\n${lines.join("\n\n")}\n\nSend /subscribe <id> with PFT to activate.\nSend /status to check your subscriptions.`;
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
      const row = db.prepare(`
        SELECT tx_hash, timestamp_iso, CAST(amount_drops AS INTEGER) as amount_drops
        FROM transactions
        WHERE destination = ?
          AND account = ?
          AND memo_type = 'subs.subscribe'
          AND memo_data_preview LIKE '%' || ? || '%'
          AND CAST(amount_drops AS INTEGER) >= ?
          AND tx_type = 'Payment'
        ORDER BY timestamp_iso DESC
        LIMIT 1
      `).get(
        protocolAddr, sender, svc.service_id, svc.price_drops
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
      return `No active subscriptions for ${sender.substring(0, 12)}...\n\nSend /services to browse available services.`;
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
  const processedTxHashes = new Set<string>();

  let running = true;
  process.on("SIGINT", () => { running = false; process.exit(0); });
  process.on("SIGTERM", () => { running = false; process.exit(0); });

  while (running) {
    try {
      const { messages, nextLedger } = await scanInbound(CHAIN_CONFIG, botKeys, sinceLedger);

      if (nextLedger > (sinceLedger ?? 0)) {
        sinceLedger = nextLedger + 1;
      }

      if (messages.length > 0) {
        console.log(`[${new Date().toISOString()}] ${messages.length} message(s)`);
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
            case "subscribe":
              response = "Subscription processing coming soon. For now, send PFT to the SUBS address with memo subs.subscribe:<service_id>.";
              break;
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
