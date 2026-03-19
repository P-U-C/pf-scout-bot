/**
 * router.ts — Parse a natural language message into a typed ScoutQuery.
 *
 * Intentionally simple keyword matching — no LLM overhead for routing.
 */

import type { ScoutQuery } from "./types.js";

// Regex to pull an r-address or @handle out of a message
const HANDLE_RE = /(?:^|[\s,])(@[\w.-]+|r[1-9A-HJ-NP-Za-km-z]{24,34})/;

export function parseQuery(message: string): ScoutQuery {
  const lower = message.toLowerCase().trim();

  // --- help ----------------------------------------------------------------
  // "help", bare "?", or very short messages with no content signals
  if (
    lower === "help" ||
    lower === "?" ||
    (/\bhelp\b/.test(lower) && !containsSearchSignals(lower))
  ) {
    return { type: "help" };
  }

  // --- profile -------------------------------------------------------------
  // "profile @user", "show me @user", "who is @user", contains r-address
  const hasProfileKeyword =
    /\bprofile\b/.test(lower) ||
    /\bshow me\b/.test(lower) ||
    /\bwho is\b/.test(lower) ||
    /\btell me about\b/.test(lower) ||
    /\bwhat do you know about\b/.test(lower);

  const handleMatch = message.match(HANDLE_RE);

  if (hasProfileKeyword || handleMatch) {
    const identifier = handleMatch
      ? handleMatch[1].replace(/^@/, "")
      : extractIdentifierFallback(message);
    return { type: "profile", identifier };
  }

  // --- list / stats --------------------------------------------------------
  if (/\b(list|top|rank|ranked|leaderboard|best|stats|statistics|how many|network|activity)\b/.test(lower)) {
    const tierMatch = lower.match(/\b(tier[- _]?[123]|top|active|new)\b/);
    const limitMatch = lower.match(/\b(\d+)\b/);
    return {
      type: "list",
      tier: tierMatch ? normalizeTier(tierMatch[1]) : undefined,
      limit: limitMatch ? Math.min(parseInt(limitMatch[1], 10), 20) : 10,
    };
  }

  // --- search (default) ----------------------------------------------------
  return {
    type: "search",
    query: message.trim(),
    limit: 5,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function containsSearchSignals(lower: string): boolean {
  return /\b(find|search|look|discover|who|developer|engineer|contributor|typescript|python|rust|solana|xrpl)\b/.test(
    lower
  );
}

function extractIdentifierFallback(message: string): string | undefined {
  // Try to grab a word that looks like a username after common verbs
  const m = message.match(/(?:about|for|profile of|on)\s+([\w.-]+)/i);
  return m ? m[1] : undefined;
}

function normalizeTier(raw: string): string {
  const s = raw.toLowerCase().replace(/[- _]/g, "");
  if (s === "tier1") return "tier1";
  if (s === "tier2") return "tier2";
  if (s === "tier3") return "tier3";
  if (s === "top") return "tier1";
  return raw;
}
