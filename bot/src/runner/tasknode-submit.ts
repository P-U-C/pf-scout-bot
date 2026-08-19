/**
 * tasknode-submit.ts — submit a text deliverable for an accepted task.
 *   config -> build pf.task.submission.v1 -> encrypt -> prepare -> sign -> submit
 *   set -a; . ~/.pftl-runner/account-ozo.env; set +a
 *   APPROVAL=1 npx tsx src/runner/tasknode-submit.ts <taskId> <deliverableFile>
 */
import sodium from "@postfiatorg/pft-chatbot-mcp/dist/crypto/sodium.js";
import { encryptPayloadForRecipients } from "@postfiatorg/pft-chatbot-mcp/dist/crypto/encrypt.js";
import { walletFromSeed } from "@postfiatorg/pft-chatbot-mcp/dist/chain/submitter.js";
import { pbkdf2Sync, createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = "https://tasknode.postfiat.org";
const JAR = `${process.env.HOME}/.pftl-runner/ozo-cookies.txt`;

function cookieHeader(): string {
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
  return { ok: r.ok, status: r.status, body: (await r.json().catch(() => ({}))) as any };
}
function deriveKeystonePub(mnemonic: string): Uint8Array {
  const seed = pbkdf2Sync(Buffer.from(mnemonic.normalize("NFKD"), "utf8"), Buffer.from("mnemonic", "utf8"), 2048, 64, "sha512");
  return sodium.crypto_box_seed_keypair(createHash("sha256").update(seed).digest()).publicKey;
}
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");
const cap = (s: string, n: number) => s.length > n ? s.slice(0, n) : s;

async function main() {
  await sodium.ready;
  const taskId = process.argv[2];
  const value = readFileSync(process.argv[3], "utf8").trim();
  const mnemonic = (process.env.BOT_SEED ?? "").trim();
  const approve = process.env.APPROVAL === "1";
  if (!taskId || !value || !mnemonic) throw new Error("need taskId + deliverableFile args + BOT_SEED");

  const cfg = await api("/api/tasks/submission", { phase: "config", taskId });
  if (!cfg.ok || !cfg.body.tasknodeEncryptionPubkey) throw new Error("config failed: " + JSON.stringify(cfg.body));
  const tnPub = new Uint8Array(Buffer.from(cfg.body.tasknodeEncryptionPubkey, "base64"));
  const wallets = cfg.body.wallets || {};
  const me = wallets.user;
  const phase = cfg.body.submissionMode || "initial_submission";
  console.log("config ok. mode:", phase, "schema:", cfg.body.schema);

  const now = new Date().toISOString();
  const item = { index: 1, artifact_type: "text", value: cap(value, 120000), notes: cap("", 8000) };
  const ev = item; // single evidence item
  const isVerify = phase === "verification_response";
  const responseText = `Evidence 1 (text): ${cap(value, 120000)}`;
  const j: Record<string, any> = {
    schema: isVerify ? "pf.task.verification_response.v1" : "pf.task.submission.v1",
    protocol: "tasknode.pftl",
    created_at: now,
    chain: "pftl-testnet",
    task_id: taskId,
    actor_wallet: me,
    subject_wallet: me,
    authority_wallet: wallets.authority || "",
    allocation_wallet: wallets.allocation || "",
    phase,
    artifact_type: "text",
    evidence_type: "text",
    evidence_count: 1,
    evidence_items: [item],
    evidence: ev,
  };
  if (isVerify) { j.responded_at = now; j.response_text = responseText; j.response = ev; }
  else { j.submitted_at = now; j.submission = ev; }
  const payload = { ...j, event_id: `evt_${sha256hex(JSON.stringify(j)).slice(0, 24)}` };

  const ownPub = deriveKeystonePub(mnemonic);
  const encryptedPayload = await encryptPayloadForRecipients(JSON.stringify(payload), [ownPub, tnPub]);
  console.log("encrypted. recipients:", encryptedPayload.recipients.map((r: any) => r.recipient_id.slice(0, 12)));

  const prep = await api("/api/tasks/submission", { phase: "prepare", taskId, encryptedPayload });
  if (!prep.ok || !prep.body.txJson) throw new Error("prepare failed: " + JSON.stringify(prep.body).slice(0, 400));
  console.log("prepare ok. cid:", prep.body.cid);
  console.log("txJson:", JSON.stringify(prep.body.txJson));

  const wallet = walletFromSeed(mnemonic);
  if (wallet.classicAddress !== me) throw new Error("wallet addr mismatch");
  if (!approve) { console.log("\n[DRY] APPROVAL!=1 — stopping before sign/submit."); return; }

  const signed = wallet.sign(prep.body.txJson);
  const sub = await api("/api/tasks/submission", {
    phase: "submit", taskId, cid: prep.body.cid, signedTxBlob: signed.tx_blob,
    pointer: prep.body.pointer, transaction: prep.body.transaction,
  });
  console.log("SUBMIT:", sub.status, JSON.stringify(sub.body).slice(0, 600));
}
main().catch(e => { console.log("ERR:", e.message); process.exit(1); });
