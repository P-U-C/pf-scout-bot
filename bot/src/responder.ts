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
    const name = p["name"] ?? p["identifier"] ?? "Unknown";
    const tier = p["tier"] ?? "—";
    const score = p["score"] ?? p["total_score"] ?? "—";
    const bio = String(p["bio"] ?? p["description"] ?? "").slice(0, 120);
    return truncate(`${name} | ${tier} | Score: ${score}\n${bio}`, 400);
  }

  if (query.type === "list" || query.type === "search") {
    const items = Array.isArray(raw) ? raw : (raw as Record<string, unknown>)["results"] ?? [];
    const arr = items as Array<Record<string, unknown>>;
    const top = arr.slice(0, 3);
    const lines = top.map((p, i) => {
      const name = p["name"] ?? p["identifier"] ?? `Result ${i + 1}`;
      const tier = p["tier"] ? ` [${p["tier"]}]` : "";
      const score = p["score"] !== undefined ? ` (${p["score"]})` : "";
      return `${i + 1}. ${name}${tier}${score}`;
    });
    const suffix =
      arr.length > 3 ? "\nReply with a handle for full profile." : "";
    return truncate(lines.join("\n") + suffix, 400);
  }

  return "Unknown query type.";
}

// ---------------------------------------------------------------------------
// Help response (no API call needed)
// ---------------------------------------------------------------------------

function helpResponse(botName: string): string {
  return (
    `${botName} — contributor intelligence for Post Fiat.\n` +
    "Commands:\n" +
    "  find <skill/role>       Search contributors\n" +
    "  list [tier1|tier2]      Ranked list\n" +
    "  profile @handle         Full profile\n" +
    "  help                    This message"
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

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + "…";
}
