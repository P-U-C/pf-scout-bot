/**
 * scout-client.ts — Thin HTTP client for the pf-scout-api (Phase 1).
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
 * Route a parsed ScoutQuery to the appropriate scout-api endpoint.
 * Returns the raw JSON response body, or null for "help" queries.
 */
export async function queryScout(q: ScoutQuery): Promise<unknown> {
  const base = config.scoutApiUrl.replace(/\/$/, "");

  switch (q.type) {
    case "help":
      return null;

    case "search": {
      const body: Record<string, unknown> = { query: q.query };
      if (q.limit !== undefined) body["limit"] = q.limit;
      if (q.tier !== undefined) body["tier"] = q.tier;
      if (q.rubric !== undefined) body["rubric"] = q.rubric;
      if (q.params) {
        for (const [key, value] of Object.entries(q.params)) {
          body[key] = value;
        }
      }

      const res = await fetchWithTimeout(`${base}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(`/search returned HTTP ${res.status}`);
      }
      return res.json();
    }

    case "profile": {
      if (!q.identifier) {
        throw new Error("profile query missing identifier");
      }

      const params = new URLSearchParams(q.params ?? {});
      const qs = params.toString() ? `?${params.toString()}` : "";

      const res = await fetchWithTimeout(
        `${base}/profile/${encodeURIComponent(q.identifier)}${qs}`
      );
      if (!res.ok) {
        throw new Error(`/profile returned HTTP ${res.status}`);
      }
      return res.json();
    }

    case "list": {
      const params = new URLSearchParams(q.params ?? {});
      if (q.tier) params.set("tier", q.tier);
      if (q.limit !== undefined) params.set("limit", String(q.limit));
      const qs = params.toString() ? `?${params.toString()}` : "";

      const res = await fetchWithTimeout(`${base}/list${qs}`);
      if (!res.ok) {
        throw new Error(`/list returned HTTP ${res.status}`);
      }
      return res.json();
    }

    default: {
      const exhaustive: never = q.type;
      throw new Error(`Unknown query type: ${exhaustive}`);
    }
  }
}
