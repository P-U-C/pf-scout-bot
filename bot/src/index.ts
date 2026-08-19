/**
 * index.ts — PF Scout Bot entry point.
 *
 * Polls the PFTL chain for inbound encrypted messages,
 * routes queries through the scout-api, and sends encrypted replies.
 *
 * Uses pft-chatbot-mcp for full keystone envelope compatibility.
 */

import { initBotKeys, scanInbound, sendReply, type ChainConfig } from "./chain.js";
import { parseQuery } from "./router.js";
import { queryScout } from "./scout-client.js";
import { formatResponse } from "./responder.js";
import { config } from "./config.js";
import { checkRateLimit, pruneExpiredBuckets, type WalletTier } from "./rate-limit.js";
import { resolveFollowUp, setSession } from "./session.js";

// ---------------------------------------------------------------------------
// Wallet tier resolution
// ---------------------------------------------------------------------------
async function resolveWalletTier(wallet: string): Promise<WalletTier> {
  try {
    const url = `${config.scoutApiUrl}/auth/tier?wallet=${encodeURIComponent(wallet)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const data = (await resp.json()) as { tier?: string };
      const tier = data.tier?.toUpperCase() as WalletTier | undefined;
      if (tier === "AUTHORIZED" || tier === "TRUSTED") return tier;
    }
  } catch {
    // Fall through to UNKNOWN
  }
  return "UNKNOWN";
}

async function main(): Promise<void> {
  if (!config.botSeed) {
    console.error("ERROR: BOT_SEED env var is required.");
    process.exit(1);
  }

  console.log("Initializing bot keys...");
  const botKeys = await initBotKeys(config.botSeed);
  console.log(`PF Scout bot running as ${botKeys.address}`);

  const chainConfig: ChainConfig = {
    pftlRpcUrl: process.env.PFTL_RPC_URL ?? "https://rpc.testnet.postfiat.org",
    pftlWssUrl: config.xrplServer,
    ipfsGatewayUrl: process.env.IPFS_GATEWAY_URL ?? "https://ipfs-testnet.postfiat.org",
    keystoneGrpcUrl: process.env.KEYSTONE_GRPC_URL ?? "keystone-grpc.postfiat.org:443",
    keystoneApiKey: process.env.KEYSTONE_API_KEY ?? "",
    tasknodeEncryptionPubkey: process.env.TASKNODE_ENCRYPTION_PUBKEY ?? "",
  };

  console.log(`Polling every ${config.pollIntervalMs / 1000}s`);
  console.log(`Scout API: ${config.scoutApiUrl}`);
  console.log(`PFTL RPC: ${chainConfig.pftlRpcUrl}`);

  let sinceLedger: number | undefined;
  let pruneCounter = 0;
  const processedTxHashes = new Set<string>(); // Prevent replays

  // Graceful shutdown
  let running = true;
  process.on("SIGINT", () => {
    console.log("\nShutting down…");
    running = false;
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    running = false;
    process.exit(0);
  });

  while (running) {
    try {
      const { messages, nextLedger } = await scanInbound(chainConfig, botKeys, sinceLedger);

      if (nextLedger > (sinceLedger ?? 0)) {
        sinceLedger = nextLedger + 1; // +1 to avoid re-processing same ledger
      }

      console.log(
        `[${new Date().toISOString()}] Scanned — ${messages.length} new message(s)`
      );

      for (const msg of messages) {
        // Skip our own outbound messages
        if (msg.sender === botKeys.address) continue;
        // Skip already-processed messages
        if (msg.txHash && processedTxHashes.has(msg.txHash)) continue;
        if (msg.txHash) processedTxHashes.add(msg.txHash);

        console.log(
          `  ← from ${msg.sender} (ledger ${msg.ledgerIndex}): ${msg.content.slice(0, 80)}`
        );

        try {
          // ── Rate limiting ──
          const tier = await resolveWalletTier(msg.sender);
          const rateCheck = checkRateLimit(msg.sender, tier);

          if (!rateCheck.allowed) {
            await sendReply(chainConfig, botKeys, msg.sender, rateCheck.message, config.botSeed);
            continue;
          }

          // ── Follow-up resolution ──
          const resolved = resolveFollowUp(msg.sender, msg.content);
          const queryText = resolved ?? msg.content;

          // ── Route to scout-api ──
          const parsed = parseQuery(queryText);
          // Pass requester wallet for SUBS status lookups
          if (parsed.type === "subs_status") {
            parsed.identifier = msg.sender;
            parsed.params = { ...parsed.params, requester_wallet: msg.sender };
          }
          console.log(`  [debug] parsed query: ${JSON.stringify(parsed)}`);
          const scoutResult = await queryScout(parsed);

          // ── Format response ──
          const response = await formatResponse(parsed, scoutResult);

          // ── Update session ──
          setSession(msg.sender, queryText, scoutResult);

          // ── Send reply on-chain (encrypted) ──
          const txHash = await sendReply(chainConfig, botKeys, msg.sender, response, config.botSeed);
          console.log(`  → sent to ${msg.sender} (${tier}, tx: ${txHash.substring(0, 16)}…)`);

        } catch (err) {
          console.error(`  ! Error handling message from ${msg.sender}:`, err);
          try {
            await sendReply(
              chainConfig, botKeys, msg.sender,
              "Sorry, an error occurred processing your query. Please try again.", config.botSeed
            );
          } catch {
            // Swallow send error
          }
        }
      }

      // Prune rate limit buckets every 10 cycles
      pruneCounter++;
      if (pruneCounter >= 10) {
        pruneExpiredBuckets();
        pruneCounter = 0;
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Poll error:`, err);
    }

    // Wait for next poll
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
