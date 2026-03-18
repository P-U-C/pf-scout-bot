/**
 * index.ts — PF Scout Bot entry point.
 *
 * Polls the XRPL every POLL_INTERVAL_MS for new inbound messages to the bot's
 * wallet address, routes them through the scout-api, formats responses with an
 * LLM (or template fallback), and sends them back on-chain.
 */

import { Client, Wallet } from "xrpl";
import { scanMessages, sendMessage } from "./chain.js";
import { parseQuery } from "./router.js";
import { queryScout } from "./scout-client.js";
import { formatResponse } from "./responder.js";
import { config } from "./config.js";

async function main(): Promise<void> {
  if (!config.botSeed) {
    console.error(
      "ERROR: BOT_SEED env var is required. Generate one with xrpl-keygen or pft-chatbot-mcp."
    );
    process.exit(1);
  }

  console.log(`Connecting to XRPL at ${config.xrplServer}…`);
  const client = new Client(config.xrplServer);

  // Reconnect on unexpected disconnect
  client.on("disconnected", () => {
    console.warn("XRPL disconnected — will attempt to reconnect on next poll.");
  });

  await client.connect();

  const wallet = Wallet.fromSeed(config.botSeed);
  console.log(`PF Scout bot running as ${wallet.classicAddress}`);
  console.log(`Polling every ${config.pollIntervalMs / 1000}s`);
  console.log(`Scout API: ${config.scoutApiUrl}`);

  let sinceledger: number | undefined;

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
      // Ensure connection is alive
      if (!client.isConnected()) {
        console.log("Reconnecting to XRPL…");
        await client.connect();
      }

      const messages = await scanMessages(client, wallet, sinceledger);
      console.log(
        `[${new Date().toISOString()}] Scanned — ${messages.length} new message(s)`
      );

      for (const msg of messages) {
        // Advance the cursor so we don't re-process this ledger
        if (sinceledger === undefined || msg.ledgerIndex > sinceledger) {
          sinceledger = msg.ledgerIndex;
        }

        console.log(
          `  ← from ${msg.sender} (ledger ${msg.ledgerIndex}): ${msg.content.slice(0, 80)}`
        );

        try {
          const query = parseQuery(msg.content);
          const rawResult = await queryScout(query);
          const response = await formatResponse(query, rawResult);

          const txHash = await sendMessage(client, wallet, msg.sender, response);
          console.log(
            `  → sent to ${msg.sender} (tx: ${txHash.slice(0, 16)}…): ${response.slice(0, 80)}`
          );
        } catch (msgErr) {
          console.error(`  ! Error handling message from ${msg.sender}:`, msgErr);

          // Best-effort error reply — don't let one bad message crash the loop
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
    } catch (err) {
      console.error("Poll error:", err);
    }

    // Wait before next poll
    await new Promise<void>((r) => setTimeout(r, config.pollIntervalMs));
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
