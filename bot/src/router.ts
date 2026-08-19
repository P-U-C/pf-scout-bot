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

  // --- network (link to visualization) --------------------------------------
  if (/\b(network|graph|visuali|map|lens)\b/.test(lower) && !/\bfind\b/.test(lower)) {
    return { type: "network" };
  }

  // --- pulse / heartbeat ----------------------------------------------------
  if (/\b(pulse|heartbeat|health|overview|status)\b/.test(lower) && !/\bprofile\b/.test(lower)) {
    return { type: "pulse" };
  }

  // --- whales ---------------------------------------------------------------
  if (/\b(whale|whales|biggest|richest|holders)\b/.test(lower)) {
    return { type: "whales" };
  }

  // --- who's active / working -----------------------------------------------
  if (/\b(active|working|workers|busy|productive|contributors)\b/.test(lower)) {
    return { type: "active" };
  }

  // --- earners / who got paid -----------------------------------------------
  if (/\b(earner|earners|paid|earned|income|receiving|getting paid)\b/.test(lower)) {
    return { type: "earners" };
  }

  // --- check / is this legit -----------------------------------------------
  if (/\b(check|legit|legitimate|verify|safe|trust)\b/.test(lower)) {
    const handleMatch = message.match(HANDLE_RE);
    return { type: "check", identifier: handleMatch ? handleMatch[1].replace(/^@/, "") : undefined };
  }

  // --- connections / who talks to who ---------------------------------------
  if (/\b(connections|connects|talks to|relationship|peers|friends)\b/.test(lower)) {
    const handleMatch = message.match(HANDLE_RE);
    return { type: "connections", identifier: handleMatch ? handleMatch[1].replace(/^@/, "") : undefined };
  }

  // --- sybil check ---------------------------------------------------------
  if (/\b(sybil|fake|bot check|suspicious)\b/.test(lower)) {
    const handleMatch = message.match(HANDLE_RE);
    return { type: "sybil_check", identifier: handleMatch ? handleMatch[1].replace(/^@/, "") : undefined };
  }

  // --- infra ----------------------------------------------------------------
  if (/\b(infra|infrastructure|team|system wallets)\b/.test(lower)) {
    return { type: "infra" };
  }

  // --- tag -----------------------------------------------------------------
  if (/\btag\b/.test(lower)) {
    // "tag rAddress label text"
    const parts = message.trim().split(/\s+/);
    const tagIdx = parts.findIndex(p => p.toLowerCase() === "tag" || p.toLowerCase() === "/tag");
    if (tagIdx >= 0 && parts.length > tagIdx + 2) {
      const addr = parts[tagIdx + 1];
      const label = parts.slice(tagIdx + 2).join(" ");
      return { type: "tag", identifier: addr, query: label };
    }
    return { type: "help" }; // bad syntax → show help
  }

  // --- richlist -------------------------------------------------------------
  if (/\b(rich|richlist|rich list|holders|whales|balances)\b/.test(lower)) {
    const limitMatch = lower.match(/\b(\d+)\b/);
    return {
      type: "richlist",
      limit: limitMatch ? Math.min(parseInt(limitMatch[1], 10), 20) : 10,
    };
  }

  // --- stats ---------------------------------------------------------------
  if (/\b(stats|statistics|how many|network|overview)\b/.test(lower)) {
    return { type: "stats" };
  }

  // --- list ----------------------------------------------------------------
  if (/\b(list|top|rank|ranked|leaderboard|best|active|activity)\b/.test(lower)) {
    const tierMatch = lower.match(/\b(tier[- _]?[123]|top|active|new)\b/);
    const limitMatch = lower.match(/\b(\d+)\b/);
    return {
      type: "list",
      tier: tierMatch ? normalizeTier(tierMatch[1]) : undefined,
      limit: limitMatch ? Math.min(parseInt(limitMatch[1], 10), 20) : 10,
    };
  }

  // --- SUBS: /services -------------------------------------------------------
  if (/^\/services\b/.test(lower) || /\b(services|marketplace|subs|subscribe)\b/.test(lower) && /\b(list|show|what|available)\b/.test(lower)) {
    return { type: "subs_services" };
  }

  // --- SUBS: /status --------------------------------------------------------
  if (/^\/status\b/.test(lower) || (/\b(subscription|subscribed|my sub)\b/.test(lower))) {
    return { type: "subs_status" };
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
