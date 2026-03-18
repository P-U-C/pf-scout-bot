/**
 * chain.ts — XRPL scanning and message sending.
 *
 * Plain-text memos only (v0). Encrypted Keystone support can be layered on
 * top later by swapping the decode step.
 */

import { Client, Wallet, xrpToDrops } from "xrpl";
import type { AccountTxTransaction } from "xrpl";
import type { InboundMessage } from "./types.js";

const MEMO_ENCODING = "text/plain";
const MIN_XRP_DROPS = xrpToDrops("0.001");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToUtf8(hex: string): string {
  const bytes = Buffer.from(hex, "hex");
  return bytes.toString("utf8");
}

function utf8ToHex(text: string): string {
  return Buffer.from(text, "utf8").toString("hex").toUpperCase();
}

function extractMemoText(tx: AccountTxTransaction): string | null {
  const txData = tx.tx_json as Record<string, unknown>;
  if (!txData) return null;

  const memos = txData["Memos"] as Array<{ Memo: { MemoData?: string; MemoType?: string } }> | undefined;
  if (!Array.isArray(memos) || memos.length === 0) return null;

  for (const memoWrapper of memos) {
    const memo = memoWrapper?.Memo;
    if (!memo?.MemoData) continue;

    try {
      const text = hexToUtf8(memo.MemoData);
      return text;
    } catch {
      // skip malformed memos
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan the bot's account for inbound Payment transactions that carry memos.
 * Returns messages received *after* sinceledger (exclusive), or all recent
 * if sinceledger is undefined.
 */
export async function scanMessages(
  client: Client,
  wallet: Wallet,
  sinceledger?: number
): Promise<InboundMessage[]> {
  const response = await client.request({
    command: "account_tx",
    account: wallet.classicAddress,
    limit: 100,
    ledger_index_min: sinceledger !== undefined ? sinceledger + 1 : -1,
    ledger_index_max: -1,
    forward: false,
  });

  const messages: InboundMessage[] = [];

  for (const entry of response.result.transactions) {
    const txJson = entry.tx_json as Record<string, unknown>;
    if (!txJson) continue;

    // Only care about incoming Payments
    if (txJson["TransactionType"] !== "Payment") continue;
    if (txJson["Destination"] !== wallet.classicAddress) continue;

    // Skip outgoing (sent by ourselves)
    if (txJson["Account"] === wallet.classicAddress) continue;

    const content = extractMemoText(entry);
    if (!content) continue;

    const ledgerIndex =
      typeof entry.ledger_index === "number"
        ? entry.ledger_index
        : typeof txJson["ledger_index"] === "number"
        ? (txJson["ledger_index"] as number)
        : 0;

    const closeTimeIso =
      typeof txJson["date"] === "number"
        ? new Date((txJson["date"] as number + 946684800) * 1000).toISOString()
        : new Date().toISOString();

    messages.push({
      txHash: (txJson["hash"] as string | undefined) ?? "",
      sender: txJson["Account"] as string,
      content,
      ledgerIndex,
      timestampIso: closeTimeIso,
    });
  }

  return messages;
}

/**
 * Send a plain-text memo back to a user on XRPL.
 * Returns the tx hash of the submitted transaction.
 */
export async function sendMessage(
  client: Client,
  wallet: Wallet,
  toAddress: string,
  content: string
): Promise<string> {
  // XRPL memo field size is limited; truncate defensively to ~980 bytes
  const safeContent =
    Buffer.byteLength(content, "utf8") > 980
      ? content.slice(0, 960) + "…"
      : content;

  const tx = {
    TransactionType: "Payment" as const,
    Account: wallet.classicAddress,
    Destination: toAddress,
    Amount: MIN_XRP_DROPS,
    Memos: [
      {
        Memo: {
          MemoType: utf8ToHex(MEMO_ENCODING),
          MemoData: utf8ToHex(safeContent),
        },
      },
    ],
  };

  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);

  const meta = result.result.meta as Record<string, unknown> | undefined;
  const txResult = meta?.["TransactionResult"];
  if (txResult !== "tesSUCCESS") {
    throw new Error(`Transaction failed: ${txResult}`);
  }

  return (result.result.tx_json as Record<string, unknown>)["hash"] as string ?? signed.hash;
}
