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

    case "infra": {
      const res = await fetchWithTimeout(`${base}/chain/infra`);
      if (!res.ok) throw new Error(`/chain/infra returned HTTP ${res.status}`);
      return res.json();
    }

    case "tag": {
      if (!q.identifier || !q.query) throw new Error("Usage: /tag <address> <label>");
      const res = await fetchWithTimeout(`${base}/chain/tag?address=${encodeURIComponent(q.identifier)}&label=${encodeURIComponent(q.query)}&tagged_by=on-chain`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`/chain/tag returned HTTP ${res.status}`);
      return res.json();
    }

    case "whales": {
      const res = await fetchWithTimeout(`${base}/chain/whales?limit=${q.limit ?? 10}`);
      if (!res.ok) throw new Error(`/chain/whales returned HTTP ${res.status}`);
      return res.json();
    }

    case "active": {
      const res = await fetchWithTimeout(`${base}/chain/active?limit=${q.limit ?? 10}`);
      if (!res.ok) throw new Error(`/chain/active returned HTTP ${res.status}`);
      return res.json();
    }

    case "connections": {
      if (!q.identifier) throw new Error("Specify a wallet address");
      const res = await fetchWithTimeout(`${base}/chain/connections/${encodeURIComponent(q.identifier)}`);
      if (!res.ok) throw new Error(`/chain/connections returned HTTP ${res.status}`);
      return res.json();
    }

    case "check": {
      if (!q.identifier) throw new Error("Specify a wallet address to check");
      const res = await fetchWithTimeout(`${base}/chain/check/${encodeURIComponent(q.identifier)}`);
      if (!res.ok) throw new Error(`/chain/check returned HTTP ${res.status}`);
      return res.json();
    }

    case "pulse": {
      const res = await fetchWithTimeout(`${base}/chain/pulse`);
      if (!res.ok) throw new Error(`/chain/pulse returned HTTP ${res.status}`);
      return res.json();
    }

    case "earners": {
      const res = await fetchWithTimeout(`${base}/chain/earners?limit=${q.limit ?? 10}`);
      if (!res.ok) throw new Error(`/chain/earners returned HTTP ${res.status}`);
      return res.json();
    }

    case "network": {
      return { url: "https://pft.permanentupperclass.com/lens/" };
    }

    case "sybil_check": {
      if (!q.identifier) {
        const res = await fetchWithTimeout(`${base}/chain/sybil`);
        if (!res.ok) throw new Error(`/chain/sybil returned HTTP ${res.status}`);
        return res.json();
      }
      const res = await fetchWithTimeout(`${base}/chain/check/${encodeURIComponent(q.identifier)}`);
      if (!res.ok) throw new Error(`/chain/check returned HTTP ${res.status}`);
      return res.json();
    }

    case "subs_services": {
      const res = await fetchWithTimeout(`${base}/chain/subs/services`);
      if (!res.ok) throw new Error(`/chain/subs/services returned HTTP ${res.status}`);
      return res.json();
    }

    case "subs_status": {
      const wallet = q.params?.requester_wallet ?? q.identifier ?? "";
      const res = await fetchWithTimeout(`${base}/chain/subs/status/${encodeURIComponent(wallet)}`);
      if (!res.ok) throw new Error(`/chain/subs/status returned HTTP ${res.status}`);
      return res.json();
    }

    default:
      throw new Error(`Unknown query type: ${(q as any).type}`);
  }
}
