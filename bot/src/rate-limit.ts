/**
 * Per-wallet rate limiter for the PF Scout bot.
 *
 * Tiers (per architecture spec):
 *   UNKNOWN    → 10 queries / hour
 *   AUTHORIZED → 60 queries / hour
 *   TRUSTED    → unlimited
 *
 * State is in-memory only — resets on bot restart.
 * No state is ever sent on-chain or persisted to disk.
 */

export type WalletTier = "TRUSTED" | "AUTHORIZED" | "UNKNOWN" | "COOLDOWN" | "SUSPENDED";

interface BucketState {
  count: number;
  resetAt: number; // unix ms
}

const HOURLY_LIMITS: Record<WalletTier, number> = {
  TRUSTED: Infinity,
  AUTHORIZED: 60,
  UNKNOWN: 10,
  COOLDOWN: 10,    // same as UNKNOWN per spec
  SUSPENDED: 0,   // blocked entirely
};

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

const _buckets = new Map<string, BucketState>();

/**
 * Returns { allowed: true } or { allowed: false, retryAfterMs: number, message: string }.
 */
export function checkRateLimit(
  wallet: string,
  tier: WalletTier
): { allowed: true } | { allowed: false; retryAfterMs: number; message: string } {
  const limit = HOURLY_LIMITS[tier];

  if (limit === Infinity) return { allowed: true };
  if (limit === 0) {
    return {
      allowed: false,
      retryAfterMs: RATE_LIMIT_WINDOW_MS,
      message: "Your account is not active on the Task Node. Complete onboarding to use PF Scout.",
    };
  }

  const now = Date.now();
  const key = `${wallet}:${tier}`;
  let bucket = _buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    _buckets.set(key, bucket);
  }

  if (bucket.count >= limit) {
    const retryAfterMs = bucket.resetAt - now;
    const retryMins = Math.ceil(retryAfterMs / 60_000);
    return {
      allowed: false,
      retryAfterMs,
      message: `Scout rate limit reached. Resets in ${retryMins}m. Earn AUTHORIZED status via Task Node contributions.`,
    };
  }

  bucket.count += 1;
  return { allowed: true };
}

/** Clears expired buckets (call periodically to prevent memory leak). */
export function pruneExpiredBuckets(): void {
  const now = Date.now();
  for (const [key, bucket] of _buckets.entries()) {
    if (now >= bucket.resetAt) _buckets.delete(key);
  }
}
