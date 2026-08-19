/**
 * chain.ts — PFTL chain I/O using pft-chatbot-mcp internals.
 *
 * Uses the same encryption/decryption, scanning, and submission code
 * as the official pft-chatbot-mcp MCP server — ensuring full compatibility
 * with the Task Node message format (keystone v1 envelopes).
 */

// Import from pft-chatbot-mcp internals
import { scanMessages as mpcScan } from "@postfiatorg/pft-chatbot-mcp/dist/chain/scanner.js";
import { decryptPayload, hasRecipientShard } from "@postfiatorg/pft-chatbot-mcp/dist/crypto/decrypt.js";
import { deriveBotKeypair, type BotKeypair } from "@postfiatorg/pft-chatbot-mcp/dist/crypto/keys.js";
import type { InboundMessage } from "./types.js";

const RIPPLE_EPOCH = 946684800;

export interface ChainConfig {
  pftlRpcUrl: string;
  pftlWssUrl: string;
  ipfsGatewayUrl: string;
  keystoneGrpcUrl: string;
  keystoneApiKey: string;
  tasknodeEncryptionPubkey: string;
}

export type BotKeys = BotKeypair;

/**
 * Initialize bot keypair from seed (mnemonic or secret).
 */
export async function initBotKeys(seed: string): Promise<BotKeys> {
  return await deriveBotKeypair(seed.trim());
}

/**
 * Scan for new inbound messages using pft-chatbot-mcp's scanner.
 * Handles both pf.ptr and keystone envelope formats.
 * Decrypts messages automatically using the bot's key.
 */
export async function scanInbound(
  chainConfig: ChainConfig,
  botKeys: BotKeys,
  sinceLedger?: number,
): Promise<{ messages: InboundMessage[]; nextLedger: number }> {
  const config = {
    pftlRpcUrl: chainConfig.pftlRpcUrl,
    pftlWssUrl: chainConfig.pftlWssUrl,
    ipfsGatewayUrl: chainConfig.ipfsGatewayUrl,
  };

  const rawMessages = await mpcScan(config, botKeys.address, {
    sinceLedger,
    limit: 50,
    direction: "inbound",
  });

  const messages: InboundMessage[] = [];
  let maxLedger = sinceLedger ?? 0;

  for (const msg of rawMessages) {
    if (msg.ledgerIndex > maxLedger) maxLedger = msg.ledgerIndex;

    // Try to decrypt and get content
    let content = "";
    if (msg.cid && msg.isEncrypted) {
      try {
        const payloadUrl = `${chainConfig.ipfsGatewayUrl}/ipfs/${msg.cid}`;
        const resp = await fetch(payloadUrl, { signal: AbortSignal.timeout(10000) });
        const blob = await resp.json();
        const decrypted = await decryptPayload(blob, botKeys.x25519PrivateKey, botKeys.x25519PublicKey);
        content = typeof decrypted === "string" ? decrypted : JSON.stringify(decrypted);
      } catch {
        // Can't decrypt — might not be addressed to us
        content = "";
      }
    } else if (msg.cid && !msg.isEncrypted) {
      try {
        const payloadUrl = `${chainConfig.ipfsGatewayUrl}/ipfs/${msg.cid}`;
        const resp = await fetch(payloadUrl, { signal: AbortSignal.timeout(10000) });
        content = await resp.text();
      } catch {
        content = "";
      }
    }

    if (!content || content.trim().length === 0) continue;

    // Extract text from decrypted content (may be JSON with a text field)
    let text = content;
    try {
      const parsed = JSON.parse(content);
      text = parsed.text ?? parsed.message ?? parsed.content ?? content;
    } catch {
      // Content is plain text
    }

    messages.push({
      txHash: msg.txHash || "",
      sender: msg.sender,
      content: text.trim(),
      ledgerIndex: msg.ledgerIndex,
      timestampIso: msg.timestampIso || new Date().toISOString(),
      amountDrops: msg.amountDrops || "0",
    });
  }

  return { messages, nextLedger: maxLedger };
}

// Cache the KeystoneClient and Config so we don't recreate per message
let _grpcClient: any = null;
let _mpcConfig: any = null;

async function getGrpcClient(chainConfig: ChainConfig, botSeed: string) {
  if (_grpcClient && _mpcConfig) return { grpcClient: _grpcClient, mpcConfig: _mpcConfig };

  const { KeystoneClient } = await import("@postfiatorg/pft-chatbot-mcp/dist/grpc/client.js");

  // Decode the TaskNode's X25519 public key for message sharing
  // This allows the TaskNode UI to decrypt and display bot replies
  const TESTNET_TASKNODE_PUBKEY = "knyyRfO9ws9JmIHjOA7v0x4+hjflnKeGIhLVS/G0BwM=";
  const tasknodeKeyB64 = process.env.TASKNODE_ENCRYPTION_PUBKEY || TESTNET_TASKNODE_PUBKEY;
  let tasknodeKey: Uint8Array | null = null;
  try {
    tasknodeKey = new Uint8Array(Buffer.from(tasknodeKeyB64, "base64"));
    if (tasknodeKey.length !== 32) tasknodeKey = null;
  } catch { /* leave null */ }

  _mpcConfig = {
    botSeed: botSeed,
    pftlRpcUrl: chainConfig.pftlRpcUrl,
    pftlWssUrl: chainConfig.pftlWssUrl,
    ipfsGatewayUrl: chainConfig.ipfsGatewayUrl,
    keystoneGrpcUrl: chainConfig.keystoneGrpcUrl,
    keystoneApiKey: chainConfig.keystoneApiKey || null,
    pingIntervalMs: 0,
    tasknodeEncryptionKey: tasknodeKey,
    tasknodeKeySource: tasknodeKey ? "testnet default" : null,
  };

  _grpcClient = new KeystoneClient(_mpcConfig);
  return { grpcClient: _grpcClient, mpcConfig: _mpcConfig };
}

/**
 * Send an encrypted reply to a user using the keystone envelope format.
 * Compatible with the Task Node UI.
 *
 * Uses pft-chatbot-mcp's executeSendMessage which handles:
 *   encrypt → upload to IPFS via Keystone gRPC → build keystone envelope → submit Payment
 */
export async function sendReply(
  chainConfig: ChainConfig,
  botKeys: BotKeys,
  toAddress: string,
  content: string,
  botSeed: string,
): Promise<string> {
  if (!content || content.trim().length === 0) {
    content = "No response available.";
  }

  if (content.length > 2000) {
    content = content.substring(0, 1950) + "…";
  }

  const { executeSendMessage } = await import(
    "@postfiatorg/pft-chatbot-mcp/dist/tools/send_message.js"
  );

  const { grpcClient, mpcConfig } = await getGrpcClient(chainConfig, botSeed);

  const txHash = await executeSendMessage(mpcConfig, botKeys, grpcClient, {
    recipient: toAddress,
    message: content,
  });

  return txHash ?? "unknown";
}
