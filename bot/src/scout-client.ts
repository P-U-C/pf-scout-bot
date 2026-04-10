/**
 * scout-client.ts — HTTP client for pf-scout-api.
 *
 * Routes queries to chain-native endpoints (/chain/*) that serve
 * directly from on-chain indexed data.
 */

import { config } from "./config.js";
import type { ScoutQuery } from "./types.js";

const TIMEOUT_MS = 10_000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Route a parsed ScoutQuery to the chain-native scout-api endpoints.
 */
export async function queryScout(q: ScoutQuery): Promise<unknown> {
  const base = config.scoutApiUrl.replace(/\/$/, "");

  switch (q.type) {
    case "help":
      return null;

    case "search": {
      // Use chain search — searches by wallet address prefix
      const res = await fetchWithTimeout(`${base}/chain/search?query=${encodeURIComponent(q.query ?? "")}&limit=${q.limit ?? 10}`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`/chain/search returned HTTP ${res.status}`);
      return res.json();
    }

    case "profile": {
      if (!q.identifier) throw new Error("profile query missing identifier");
      // Use chain profile — returns on-chain wallet activity
      const res = await fetchWithTimeout(`${base}/chain/profile/${encodeURIComponent(q.identifier)}`);
      if (!res.ok) throw new Error(`/chain/profile returned HTTP ${res.status}`);
      return res.json();
    }

    case "list": {
      const params = new URLSearchParams();
      if (q.limit !== undefined) params.set("limit", String(q.limit));
      params.set("min_memos", "1");
      const qs = params.toString() ? `?${params.toString()}` : "";
      const res = await fetchWithTimeout(`${base}/chain/list${qs}`);
      if (!res.ok) throw new Error(`/chain/list returned HTTP ${res.status}`);
      return res.json();
    }

    case "richlist": {
      const limit = q.limit ?? 10;
      const res = await fetchWithTimeout(`${base}/chain/richlist?limit=${limit}`);
      if (!res.ok) throw new Error(`/chain/richlist returned HTTP ${res.status}`);
      return res.json();
    }

    case "stats": {
      const res = await fetchWithTimeout(`${base}/chain/stats`);
      if (!res.ok) throw new Error(`/chain/stats returned HTTP ${res.status}`);
      return res.json();
    }

    default:
      throw new Error(`Unknown query type: ${(q as any).type}`);
  }
}
