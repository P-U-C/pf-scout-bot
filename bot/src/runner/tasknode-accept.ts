/**
 * tasknode-accept.ts — accept a Task Node task via the official lifecycle:
 *   config -> build pf.task.update.v1 -> encrypt to [ownKeystone, tasknode] -> prepare -> sign -> submit
 * Replicates the tasknode UI flow (reverse-engineered). Run:
 *   set -a; . ~/.pftl-runner/account-ozo.env; set +a
 *   APPROVAL=1 npx tsx src/runner/tasknode-accept.ts <taskId>
 * Without APPROVAL=1 it stops after prepare and prints txJson (dry inspect).
 */
import sodium from "@postfiatorg/pft-chatbot-mcp/dist/crypto/sodium.js";
import { encryptPayloadForRecipients } from "@postfiatorg/pft-chatbot-mcp/dist/crypto/encrypt.js";
import { pbkdf2Sync, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { walletFromSeed } from "@postfiatorg/pft-chatbot-mcp/dist/chain/submitter.js";

const BASE = "https://tasknode.postfiat.org";
const JAR = `${process.env.HOME}/.pftl-runner/ozo-cookies.txt`;

function cookieHeader(): string {
  // netscape cookie jar -> "name=value; ..."
  // netscape jar; HttpOnly cookies are prefixed "#HttpOnly_" — keep those, drop only real comments
  const lines = readFileSync(JAR, "utf8").split("\n")
    .map(l => l.startsWith("#HttpOnly_") ? l.slice("#HttpOnly_".length) : l)
    .filter(l => l && !l.startsWith("#"));
  return lines.map(l => { const p = l.split("\t"); return p.length >= 7 ? `${p[5]}=${p[6]}` : ""; }).filter(Boolean).join("; ");
}

async function api(path: string, body: any) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "origin": BASE, "cookie": cookieHeader() },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: j as any };
}

function deriveKeystonePub(mnemonic: string): Uint8Array {
  const seed = pbkdf2Sync(Buffer.from(mnemonic.normalize("NFKD"), "utf8"), Buffer.from("mnemonic", "utf8"), 2048, 64, "sha512");
  const kp = sodium.crypto_box_seed_keypair(createHash("sha256").update(seed).digest());
  return kp.publicKey;
}
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

async function main() {
  await sodium.ready;
  const taskId = process.argv[2];
  const mnemonic = (process.env.BOT_SEED ?? "").trim();
  const approve = process.env.APPROVAL === "1";
  if (!taskId || !mnemonic) throw new Error("need taskId arg + BOT_SEED env");

  // 1. config
  const cfg = await api("/api/tasks/action", { phase: "config", taskId, taskAction: "accept" });
  if (!cfg.ok || !cfg.body.tasknodeEncryptionPubkey) throw new Error("config failed: " + JSON.stringify(cfg.body));
  const tnPub = new Uint8Array(Buffer.from(cfg.body.tasknodeEncryptionPubkey, "base64"));
  const wallets = cfg.body.wallets || {};
  const me = wallets.user;
  console.log("config ok. user:", me, "authority:", wallets.authority);

  // 2. build pf.task.update.v1 (exact key order from the UI) + event_id
  const now = new Date().toISOString();
  const w: Record<string, any> = {
    schema: "pf.task.update.v1",
    protocol: "tasknode.pftl",
    created_at: now,
    chain: "pftl-testnet",
    task_id: taskId,
    actor_wallet: me,
    subject_wallet: me,
    authority_wallet: wallets.authority || "",
    allocation_wallet: wallets.allocation || "",
    transition: "accepted",
    status_after: "accepted",
    reason: "User accepted the task.",
    accepted_at: now,
  };
  const D = { ...w, event_id: `evt_${sha256hex(JSON.stringify(w)).slice(0, 24)}` };

  // 3. encrypt to [own keystone, tasknode]
  const ownPub = deriveKeystonePub(mnemonic);
  const encryptedPayload = await encryptPayloadForRecipients(JSON.stringify(D), [ownPub, tnPub]);
  console.log("encrypted. recipients:", encryptedPayload.recipients.map((r: any) => r.recipient_id.slice(0, 12)));

  // 4. prepare
  const prep = await api("/api/tasks/action", { phase: "prepare", taskId, taskAction: "accept", encryptedPayload });
  if (!prep.ok || !prep.body.txJson) throw new Error("prepare failed: " + JSON.stringify(prep.body).slice(0, 400));
  console.log("prepare ok. cid:", prep.body.cid);
  console.log("txJson:", JSON.stringify(prep.body.txJson));

  // 5. sign txJson with ozo's wallet (from mnemonic)
  const wallet = walletFromSeed(mnemonic);
  console.log("signing wallet addr:", wallet.classicAddress, "(expect", me + ")");
  if (wallet.classicAddress !== me) throw new Error("wallet addr mismatch — aborting before sign");

  if (!approve) { console.log("\n[DRY] APPROVAL!=1 — stopping before sign/submit."); return; }

  const signed = wallet.sign(prep.body.txJson);
  // 6. submit
  const sub = await api("/api/tasks/action", {
    phase: "submit", taskId, taskAction: "accept",
    cid: prep.body.cid, signedTxBlob: signed.tx_blob,
    pointer: prep.body.pointer, transaction: prep.body.transaction,
  });
  console.log("SUBMIT:", sub.status, JSON.stringify(sub.body).slice(0, 500));
}
main().catch(e => { console.log("ERR:", e.message); process.exit(1); });
