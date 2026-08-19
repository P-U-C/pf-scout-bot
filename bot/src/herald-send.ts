/**
 * herald-send.ts — batch-send the daily Herald edition on-chain to subscribers.
 *
 * Called by deploy/deliver-herald.sh. Reads /tmp/herald-delivery-request.json
 * containing { edition_date, recipients[], content }, then sends the encrypted
 * keystone envelope to each recipient using the same stack the SUBS bot uses
 * for replies.
 *
 * Writes /tmp/herald-delivery-result.json with { delivered: [addrs] }.
 */

import fs from "fs";
import { initBotKeys, sendReply, type ChainConfig } from "./chain.js";

const REQUEST_PATH = process.argv[2] || "/tmp/herald-delivery-request.json";
const RESULT_PATH = "/tmp/herald-delivery-result.json";

interface DeliveryRequest {
  edition_date: string;
  recipients: string[];
  content: string;
}

async function main(): Promise<void> {
  const subsSeed = process.env.SUBS_SEED;
  if (!subsSeed) {
    console.error("SUBS_SEED env var is required");
    process.exit(1);
  }

  const req = JSON.parse(fs.readFileSync(REQUEST_PATH, "utf-8")) as DeliveryRequest;
  if (!req.recipients?.length) {
    console.log("No recipients, exiting");
    fs.writeFileSync(RESULT_PATH, JSON.stringify({ delivered: [] }));
    return;
  }

  console.log(`Herald sender: edition ${req.edition_date}, ${req.recipients.length} recipients`);
  console.log(`Content length: ${req.content.length} chars`);

  const botKeys = await initBotKeys(subsSeed);
  console.log(`Sending from ${botKeys.address}`);

  const chainConfig: ChainConfig = {
    pftlRpcUrl: process.env.PFTL_RPC_URL ?? "http://127.0.0.1:5015",
    pftlWssUrl: process.env.XRPL_SERVER ?? "wss://ws.testnet.postfiat.org",
    ipfsGatewayUrl: process.env.IPFS_GATEWAY_URL ?? "https://ipfs-testnet.postfiat.org",
    keystoneGrpcUrl: process.env.KEYSTONE_GRPC_URL ?? "keystone-grpc.postfiat.org:443",
    keystoneApiKey: process.env.KEYSTONE_API_KEY ?? "",
    tasknodeEncryptionPubkey: process.env.TASKNODE_ENCRYPTION_PUBKEY ?? "",
  };

  const delivered: string[] = [];
  for (const recipient of req.recipients) {
    try {
      const header = `THE HIVE HERALD — ${req.edition_date}\n${'='.repeat(32)}\n\n`;
      const body = header + req.content + `\n\n${'='.repeat(32)}\nRead online: pft.permanentupperclass.com/herald/`;
      const txHash = await sendReply(chainConfig, botKeys, recipient, body, subsSeed);
      console.log(`  delivered → ${recipient.substring(0, 15)}... tx ${txHash.substring(0, 16)}...`);
      delivered.push(recipient);
      // Small pause so we don't hammer the node
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.error(`  FAILED → ${recipient}:`, err instanceof Error ? err.message : err);
    }
  }

  fs.writeFileSync(RESULT_PATH, JSON.stringify({ delivered }));
  console.log(`Done: ${delivered.length}/${req.recipients.length} delivered`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
