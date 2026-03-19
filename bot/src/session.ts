/**
 * session.ts — Per-wallet conversation context for follow-up queries.
 *
 * Maintains a TTL-based in-memory map of wallet → last interaction,
 * so follow-ups like "tell me more about that contributor" resolve
 * to the most recent profile/search result.
 */

import type { ScoutQuery } from "./types.js";

export interface SessionEntry {
  lastQuery: ScoutQuery;
  lastResults: unknown; // raw scout-api response
  lastIdentifiers: string[]; // extracted handles/identifiers from results
  updatedAt: number;
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const sessions = new Map<string, SessionEntry>();

const FOLLOW_UP_SIGNALS: RegExp[] = [
  /\btell me more\b/i,
  /\bmore about\b/i,
  /\bthat one\b/i,
  /\bthe first one\b/i,
  /\bthem\b/i,
  /\bdetails\b/i,
  /\bexpand\b/i,
];

const MESSAGE_IDENTIFIER_RE = /(?:^|[\s,])(@?[\w.:-]+|r[1-9A-HJ-NP-Za-km-z]{24,34})(?=$|[\s,.!?])/;

export function getSession(wallet: string): SessionEntry | undefined {
  const existing = sessions.get(wallet);
  if (!existing) return undefined;

  if (Date.now() - existing.updatedAt > SESSION_TTL_MS) {
    sessions.delete(wallet);
    return undefined;
  }

  return existing;
}

export function setSession(wallet: string, query: ScoutQuery, results: unknown): void {
  const entry: SessionEntry = {
    lastQuery: query,
    lastResults: results,
    lastIdentifiers: extractIdentifiers(results),
    updatedAt: Date.now(),
  };

  sessions.set(wallet, entry);
}

export function resolveFollowUp(wallet: string, message: string): ScoutQuery | null {
  if (!isFollowUp(message)) return null;

  const session = getSession(wallet);
  if (!session || session.lastIdentifiers.length === 0) {
    return null;
  }

  const identifier = pickIdentifier(message, session.lastIdentifiers);
  if (!identifier) return null;

  return {
    type: "profile",
    identifier,
  };
}

function isFollowUp(message: string): boolean {
  return FOLLOW_UP_SIGNALS.some((re) => re.test(message));
}

function pickIdentifier(message: string, identifiers: string[]): string | undefined {
  if (identifiers.length === 0) return undefined;

  if (/\b(the first one|first one)\b/i.test(message)) {
    return identifiers[0];
  }

  const explicit = extractMessageIdentifier(message);
  if (explicit) {
    const explicitKey = normalizeIdentifier(explicit);
    const match = identifiers.find((id) => normalizeIdentifier(id) === explicitKey);
    if (match) return match;
  }

  return identifiers[0];
}

function extractMessageIdentifier(message: string): string | undefined {
  const m = message.match(MESSAGE_IDENTIFIER_RE);
  if (!m) return undefined;
  return sanitizeIdentifier(m[1]);
}

function extractIdentifiers(results: unknown): string[] {
  const out: string[] = [];

  const collectFromRecord = (record: Record<string, unknown>): void => {
    pushIdentifier(out, record["identifier"]);
    pushIdentifier(out, record["handle"]);
    pushIdentifier(out, record["username"]);

    const allIdentifiers = record["all_identifiers"];
    if (Array.isArray(allIdentifiers)) {
      for (const id of allIdentifiers) {
        pushIdentifier(out, id);
      }
    }

    const identifiers = record["identifiers"];
    if (Array.isArray(identifiers)) {
      for (const id of identifiers) {
        pushIdentifier(out, id);
      }
    }
  };

  if (Array.isArray(results)) {
    for (const item of results) {
      if (isRecord(item)) collectFromRecord(item);
    }
  } else if (isRecord(results)) {
    const maybeResults = results["results"];
    if (Array.isArray(maybeResults)) {
      for (const item of maybeResults) {
        if (isRecord(item)) collectFromRecord(item);
      }
    } else {
      collectFromRecord(results);
    }
  }

  return dedupeIdentifiers(out);
}

function pushIdentifier(target: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const cleaned = sanitizeIdentifier(value);
  if (!cleaned) return;
  target.push(cleaned);
}

function sanitizeIdentifier(raw: string): string {
  const trimmed = raw.trim().replace(/^@/, "");
  if (!trimmed) return "";

  // Avoid storing free-form display names as profile identifiers.
  if (/\s/.test(trimmed)) return "";

  return trimmed;
}

function dedupeIdentifiers(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const id of ids) {
    const key = normalizeIdentifier(id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }

  return out;
}

function normalizeIdentifier(identifier: string): string {
  return identifier.trim().replace(/^@/, "").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
