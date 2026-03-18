/**
 * index.ts — PF Scout Bot entry point.
 *
 * Polls the XRPL every POLL_INTERVAL_MS for new inbound messages to the bot's
 * wallet address, routes them through the scout-api, formats responses with an
 * LLM (or template fallback), and sends them back on-chain.
 *
 * Security: per-wallet rate limiting enforced before any scout-api call.
 *   UNKNOWN    → 10 queries / hour
 *   AUTHORIZED → 60 queries / hour
 *   TRUSTED    → unlimited
 */

import { Client, Wallet } from "xrpl";
import { scanMessages, sendMessage } from "./chain.js";
import { parseQuery } from "./router.js";
import { queryScout } from "./scout-client.js";
import { formatResponse } from "./responder.js";
import { config } from "./config.js";
import { checkRateLimit, pruneExpiredBuckets, type WalletTier } from "./rate-limit.js";

// ---------------------------------------------------------------------------
// Wallet tier resolution
// Calls scout-api GET /auth/tier?wallet=<address> — falls back to UNKNOWN.
// ---------------------------------------------------------------------------
async function resolveWalletTier(wallet: string): Promise<WalletTier> {
  try {
    const url = `${config.scoutApiUrl}/auth/tier?wallet=${encodeURIComponent(wallet)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const data = await resp.json() as { tier?: string };
      const tier = data.tier?.toUpperCase() as WalletTier | undefined;
      if (tier && ["TRUSTED", "AUTHORIZED", "UNKNOWN", "COOLDOWN", "SUSPENDED"].includes(tier)) {
        return tier;
      }
    }
  } catch {
    // scout-api unreachable or timeout — default to UNKNOWN (safe)
  }
  return "UNKNOWN";
}

async function main(): Promise<void> {
  if (!config.botSeed) {
    console.error(
      "ERROR: BOT_SEED env var is required. Generate one with xrpl-keygen or pft-chatbot-mcp."
    );
    process.exit(1);
  }

  console.log(`Connecting to XRPL at ${config.xrplServer}…`);
  const client = new Client(config.xrplServer);

  client.on("disconnected", () => {
    console.warn("XRPL disconnected — will attempt to reconnect on next poll.");
  });

  await client.connect();

  const wallet = Wallet.fromSeed(config.botSeed);
  console.log(`PF Scout bot running as ${wallet.classicAddress}`);
  console.log(`Polling every ${config.pollIntervalMs / 1000}s`);
  console.log(`Scout API: ${config.scoutApiUrl}`);

  let sinceledger: number | undefined;
  let pruneCounter = 0;

  // Graceful shutdown
  let running = true;
  process.on("SIGINT", () => {
    console.log("\nShutting down…");
    running = false;
    client.disconnect().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    running = false;
    client.disconnect().finally(() => process.exit(0));
  });

  while (running) {
    try {
      if (!client.isConnected()) {
        console.log("Reconnecting to XRPL…");
        await client.connect();
      }

      const messages = await scanMessages(client, wallet, sinceledger);
      console.log(
        `[${new Date().toISOString()}] Scanned — ${messages.length} new message(s)`
      );

      for (const msg of messages) {
        if (sinceledger === undefined || msg.ledgerIndex > sinceledger) {
          sinceledger = msg.ledgerIndex;
        }

        console.log(
          `  ← from ${msg.sender} (ledger ${msg.ledgerIndex}): ${msg.content.slice(0, 80)}`
        );

        try {
          // ── Rate limiting ────────────────────────────────────────────────
          const tier = await resolveWalletTier(msg.sender);
          const rateCheck = checkRateLimit(msg.sender, tier);

          if (!rateCheck.allowed) {
            await sendMessage(client, wallet, msg.sender, rateCheck.message);
            console.log(`  ⏱ rate limited ${msg.sender} (${tier}): ${rateCheck.message}`);
            continue;
          }

          // ── Route + query ────────────────────────────────────────────────
          const query = parseQuery(msg.content);

          // Pass requester wallet to scout-api for field-level visibility filtering
          if (!query.params) query.params = {};
          query.params.requester_wallet = msg.sender;

          const rawResult = await queryScout(query);
          const response = await formatResponse(query, rawResult);

          const txHash = await sendMessage(client, wallet, msg.sender, response);
          console.log(
            `  → sent to ${msg.sender} (${tier}, tx: ${txHash.slice(0, 16)}…): ${response.slice(0, 80)}`
          );
        } catch (msgErr) {
          console.error(`  ! Error handling message from ${msg.sender}:`, msgErr);
          try {
            await sendMessage(
              client,
              wallet,
              msg.sender,
              "Sorry, an error occurred processing your query. Please try again."
            );
          } catch {
            // ignore send failure
          }
        }
      }

      // Prune expired rate limit buckets every 60 polls (~1 hour at 60s interval)
      if (++pruneCounter % 60 === 0) {
        pruneExpiredBuckets();
      }
    } catch (err) {
      console.error("Poll error:", err);
    }

    await new Promise<void>((r) => setTimeout(r, config.pollIntervalMs));
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
