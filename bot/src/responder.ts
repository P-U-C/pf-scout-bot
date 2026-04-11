/**
 * responder.ts — Format raw scout-api results into a concise on-chain reply.
 *
 * If an LLM API key is configured, use the LLM for polished formatting.
 * Otherwise fall back to deterministic template rendering.
 *
 * Target: 280-400 chars max (XRPL memo space is limited).
 */

import { config } from "./config.js";
import type { ScoutQuery } from "./types.js";

const SYSTEM_PROMPT = `\
You are PF Scout, a contributor intelligence bot for the Post Fiat ecosystem.
You help Task Node participants find collaborators and talent.

When presenting search results:
- Be concise (max 400 chars — this goes on-chain)
- Lead with the most relevant result
- Include: name, tier, key skills/signals, why they're interesting
- End with: "Reply with their handle for full profile"

When presenting a profile:
- Name, tier, score
- Top 2-3 signals (GitHub activity, PF contribution, skills)
- Recent activity if available
- One sentence recommendation

NEVER exceed 400 characters total.`;

// ---------------------------------------------------------------------------
// LLM formatting
// ---------------------------------------------------------------------------

async function formatWithAnthropic(
  query: ScoutQuery,
  raw: unknown
): Promise<string> {
  // Dynamic import so the SDK is only loaded when needed
  const { Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const userMessage = buildUserMessage(query, raw);
  const msg = await client.messages.create({
    model: config.model,
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const text =
    msg.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("") ?? "";

  return truncate(text.trim(), 400);
}

async function formatWithOpenAI(
  query: ScoutQuery,
  raw: unknown
): Promise<string> {
  const { OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: config.openaiApiKey });

  const userMessage = buildUserMessage(query, raw);
  const completion = await client.chat.completions.create({
    model: config.model.startsWith("claude") ? "gpt-4o-mini" : config.model,
    max_tokens: 256,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
  });

  const text = completion.choices[0]?.message?.content ?? "";
  return truncate(text.trim(), 400);
}

function buildUserMessage(query: ScoutQuery, raw: unknown): string {
  return `Query type: ${query.type}
${query.query ? `Query: ${query.query}` : ""}
${query.identifier ? `Identifier: ${query.identifier}` : ""}

Raw API result (JSON):
${JSON.stringify(raw, null, 2).slice(0, 1500)}

Format a concise on-chain response (max 400 chars).`;
}

// ---------------------------------------------------------------------------
// Template fallback
// ---------------------------------------------------------------------------

function formatTemplate(query: ScoutQuery, raw: unknown): string {
  if (!raw || (Array.isArray(raw) && raw.length === 0)) {
    return "No results found. Try broadening your search. Type 'help' for usage.";
  }

  if (query.type === "profile") {
    const p = raw as Record<string, unknown>;
    // Chain profile format
    if (p["address"]) {
      const addr = String(p["address"]);
      const short = addr.substring(0, 8) + "..." + addr.substring(addr.length - 6);
      const memos = p["memo_tx_count"] ?? 0;
      const peers = p["peer_count"] ?? 0;
      const score = p["activity_score"] ?? 0;
      const sybil = p["sybil_cluster"] ? ` [SYBIL: ${p["sybil_cluster"]}]` : "";
      const cps = (p["top_counterparties"] as Array<Record<string, unknown>> ?? []).slice(0, 3);
      const cpLines = cps.map(cp => {
        const cpAddr = String(cp["address"] ?? "");
        return `  ${cpAddr.substring(0, 10)}... (${cp["memos"]} memos)`;
      }).join("\n");
      return truncate(
        `${short}${sybil}\nActivity: ${score} | Memos: ${memos} | Peers: ${peers}\n` +
        (cpLines ? `Top peers:\n${cpLines}` : ""),
        400
      );
    }
    // Legacy contacts format
    const name = p["name"] ?? p["identifier"] ?? "Unknown";
    const tier = p["tier"] ?? "—";
    const score = p["score"] ?? p["total_score"] ?? "—";
    const bio = String(p["bio"] ?? p["description"] ?? "").slice(0, 120);
    return truncate(`${name} | ${tier} | Score: ${score}\n${bio}`, 400);
  }

  if (query.type === "list" || query.type === "search") {
    const items = Array.isArray(raw) ? raw : (raw as Record<string, unknown>)["results"] ?? [];
    const arr = items as Array<Record<string, unknown>>;
    if (arr.length === 0) {
      return "No results found. Try broadening your search. Type 'help' for usage.";
    }
    const top = arr.slice(0, 5);
    const lines = top.map((p, i) => {
      // Chain wallet format
      if (p["address"]) {
        const addr = String(p["address"]);
        const short = addr.substring(0, 10) + "...";
        const memos = p["memo_tx_count"] ?? 0;
        const peers = p["peer_count"] ?? 0;
        const sybil = p["sybil_flagged"] ? " ⚠" : "";
        return `${i + 1}. ${short} ${memos} memos, ${peers} peers${sybil}`;
      }
      // Legacy contacts format
      const name = p["name"] ?? p["identifier"] ?? `Result ${i + 1}`;
      const tier = p["tier"] ? ` [${p["tier"]}]` : "";
      const score = p["score"] !== undefined ? ` (${p["score"]})` : "";
      return `${i + 1}. ${name}${tier}${score}`;
    });
    const header = `Top ${top.length} active wallets:\n`;
    const suffix = arr.length > 5 ? "\nSend wallet address for full profile." : "";
    return truncate(header + lines.join("\n") + suffix, 400);
  }

  if (query.type === "richlist") {
    const data = raw as Record<string, unknown>;
    const items = (data["richlist"] ?? []) as Array<Record<string, unknown>>;
    if (items.length === 0) return "No balance data available.";
    const lines = items.slice(0, 10).map((p) => {
      const addr = String(p["address"] ?? "");
      const short = addr.substring(0, 10) + "...";
      const label = p["label"] ? ` (${p["label"]})` : "";
      const bal = Number(p["balance_pft"] ?? 0);
      const fmt = bal >= 1_000_000 ? `${(bal / 1_000_000).toFixed(1)}M` : bal >= 1000 ? `${(bal / 1000).toFixed(0)}K` : bal.toFixed(0);
      return `${p["rank"]}. ${short}${label} ${fmt} PFT`;
    });
    return truncate("PFT Rich List (users only):\n" + lines.join("\n"), 400);
  }

  if (query.type === "infra") {
    const data = raw as Record<string, unknown>;
    const items = (data["infrastructure"] ?? []) as Array<Record<string, unknown>>;
    if (items.length === 0) return "No infrastructure wallets tagged.";
    const lines = items.map((p) => {
      const addr = String(p["address"] ?? "");
      const short = addr.substring(0, 10) + "...";
      const bal = Number(p["balance_pft"] ?? 0);
      const fmt = bal >= 1_000_000 ? `${(bal / 1_000_000).toFixed(1)}M` : bal >= 1000 ? `${(bal / 1000).toFixed(0)}K` : bal.toFixed(0);
      return `${p["label"]}: ${short} ${fmt} PFT`;
    });
    return truncate("Infrastructure Wallets:\n" + lines.join("\n"), 400);
  }

  if (query.type === "tag") {
    const data = raw as Record<string, unknown>;
    if (data["error"]) return String(data["error"]);
    if (data["tagged"]) {
      const addr = String(data["address"] ?? "");
      const short = addr.substring(0, 12) + "...";
      return `Tagged ${short} as "${data["label"]}"`;
    }
    return "Tag failed.";
  }

  if (query.type === "network") {
    return "Lens — live network graph:\nhttps://pft.permanentupperclass.com/lens/\n\n87 wallets. 1,005 relationships.\nFilters, focus/dim, relationship inspector.";
  }

  if (query.type === "pulse") {
    const s = raw as Record<string, unknown>;
    return truncate(
      `Network Pulse:\n` +
      `${s["wallets"]} wallets | ${s["relationships"]} edges | ${s["memos"]} memos\n` +
      `Sybil clusters: ${s["sybil_clusters"]}\n` +
      `Concentration: ${s["concentration_hhi"]} (${s["health"]})\n` +
      `Graph: ${s["lens_url"] || "pft.permanentupperclass.com/lens/"}`,
      400
    );
  }

  if (query.type === "whales") {
    const data = raw as Record<string, unknown>;
    const items = (data["whales"] ?? []) as Array<Record<string, unknown>>;
    if (items.length === 0) return "No whale data.";
    const lines = items.slice(0, 8).map((p) => {
      const addr = String(p["address"] ?? "").substring(0, 10) + "...";
      const label = p["label"] ? ` (${p["label"]})` : "";
      const bal = fmtBal(Number(p["balance_pft"] ?? 0));
      return `${p["rank"]}. ${addr}${label} ${bal}`;
    });
    return truncate("Biggest whales:\n" + lines.join("\n"), 400);
  }

  if (query.type === "active") {
    const data = raw as Record<string, unknown>;
    const items = (data["active"] ?? []) as Array<Record<string, unknown>>;
    if (items.length === 0) return "No activity data.";
    const lines = items.slice(0, 8).map((p) => {
      const addr = String(p["address"] ?? "").substring(0, 10) + "...";
      const label = p["label"] ? ` (${p["label"]})` : "";
      return `${p["rank"]}. ${addr}${label} ${p["memos"]} msgs, ${p["txns"]} txns`;
    });
    return truncate("Most active (by work, not wealth):\n" + lines.join("\n"), 400);
  }

  if (query.type === "earners") {
    const data = raw as Record<string, unknown>;
    const items = (data["earners"] ?? []) as Array<Record<string, unknown>>;
    if (items.length === 0) return "No earner data.";
    const lines = items.slice(0, 8).map((p) => {
      const addr = String(p["address"] ?? "").substring(0, 10) + "...";
      const label = p["label"] ? ` (${p["label"]})` : "";
      const bal = fmtBal(Number(p["total_received_pft"] ?? 0));
      return `${p["rank"]}. ${addr}${label} received ${bal}`;
    });
    return truncate("Top earners (most PFT received):\n" + lines.join("\n"), 400);
  }

  if (query.type === "check" || query.type === "sybil_check") {
    const d = raw as Record<string, unknown>;
    if (d["error"]) return String(d["error"]);
    const addr = String(d["address"] ?? "").substring(0, 12) + "...";
    return truncate(
      `${addr}\n` +
      `Balance: ${fmtBal(Number(d["balance_pft"] ?? 0))}\n` +
      `Memos: ${d["memos"]} | Txns: ${d["txns"]} | Peers: ${d["peers"]}\n` +
      `Network share: ${d["network_share"]}%\n` +
      `Verdict: ${d["verdict"]}`,
      400
    );
  }

  if (query.type === "connections") {
    const data = raw as Record<string, unknown>;
    const items = (data["connections"] ?? []) as Array<Record<string, unknown>>;
    if (items.length === 0) return "No connections found.";
    const addr = String(data["address"] ?? "").substring(0, 10) + "...";
    const lines = items.slice(0, 6).map((p) => {
      const peer = String(p["address"] ?? "").substring(0, 10) + "...";
      const label = p["label"] ? ` (${p["label"]})` : "";
      const details = [];
      if (Number(p["memos"]) > 0) details.push(`${p["memos"]} msgs`);
      if (Number(p["pft"]) > 0) details.push(fmtBal(Number(p["pft"])));
      return `  ${peer}${label}: ${details.join(", ")}`;
    });
    return truncate(`${addr} connections:\n` + lines.join("\n"), 400);
  }

  if (query.type === "stats") {
    const s = raw as Record<string, unknown>;
    return truncate(
      `Network Stats:\n` +
      `Accounts: ${s["total_accounts"]} (${s["active_accounts"]} active)\n` +
      `Transactions: ${s["total_transactions"]} (${s["memo_transactions"]} memos)\n` +
      `Edges: ${s["total_edges"]}\n` +
      `Sybil clusters: ${s["sybil_clusters"]}\n` +
      `Last crawl: ${s["last_crawl"] ?? "never"}`,
      400
    );
  }

  return "Unknown query type.";
}

// ---------------------------------------------------------------------------
// Help response (no API call needed)
// ---------------------------------------------------------------------------

function helpResponse(_botName: string): string {
  return (
    "Lens — on-chain intelligence.\n\n" +
    "Who's here?\n" +
    "  /whales        Biggest holders\n" +
    "  /active        Who's working\n" +
    "  /earners       Who got paid\n\n" +
    "Investigate:\n" +
    "  /check <addr>  Is this legit?\n" +
    "  /connections <addr>  Who do they talk to?\n" +
    "  /sybil <addr>  Sybil check\n\n" +
    "Network:\n" +
    "  /pulse         Heartbeat\n" +
    "  /network       Live graph\n" +
    "  /infra         System wallets\n" +
    "  /tag <addr> <label>  Tag a wallet"
  );
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function formatResponse(
  query: ScoutQuery,
  raw: unknown
): Promise<string> {
  // Help is always handled locally
  if (query.type === "help") {
    return helpResponse(config.botName);
  }

  // Try LLM formatting if a key is available
  try {
    if (config.anthropicApiKey) {
      return await formatWithAnthropic(query, raw);
    }
    if (config.openaiApiKey) {
      return await formatWithOpenAI(query, raw);
    }
  } catch (err) {
    console.warn("LLM formatting failed, falling back to template:", err);
  }

  return formatTemplate(query, raw);
}

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

function fmtBal(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M PFT';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K PFT';
  return n.toFixed(0) + ' PFT';
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + "…";
}
