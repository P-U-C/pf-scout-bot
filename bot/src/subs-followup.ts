/**
 * subs-followup.ts — Follow-up offers for interested non-subscribers
 *
 * Tracks users who interacted with the SUBS bot (sent /services, /subscribe, etc.)
 * but did NOT complete a subscription. After 7 days, sends a promotional offer:
 * - First week free, OR
 * - 100 PFT discount (900 PFT instead of 1000)
 *
 * Offers are sent once per user. A persistent file tracks who has been contacted.
 */

import sqlite3 from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";

const DB_PATH = process.env.INDEXER_DB_PATH ?? path.join(os.homedir(), ".pf-scout", "chain-index.db");
const FOLLOWUP_FILE = path.join(os.homedir(), ".pf-scout", "subs-followups.json");
const SUBS_ADDRESS = "r9XYDxJDbmmhSGNpUguVhea6xn3Tu2HbeF";
const HERALD_PRICE_DROPS = 1_000_000_000; // 1000 PFT
const FOLLOWUP_DELAY_DAYS = 7;
const DISCOUNT_PFT = 100; // 100 PFT off
const DISCOUNTED_PRICE = 900; // 900 PFT

// ─── Follow-up state persistence ────────────────────────────────────

interface FollowupState {
  /** Addresses that have been sent a follow-up offer */
  contacted: Record<string, { contacted_at: string; offer_type: string }>;
  /** Addresses that redeemed a discount */
  redeemed: Record<string, { redeemed_at: string }>;
}

function loadFollowupState(): FollowupState {
  try {
    return JSON.parse(fs.readFileSync(FOLLOWUP_FILE, "utf-8"));
  } catch {
    return { contacted: {}, redeemed: {} };
  }
}

function saveFollowupState(state: FollowupState): void {
  fs.writeFileSync(FOLLOWUP_FILE, JSON.stringify(state, null, 2));
}

// ─── Core logic ─────────────────────────────────────────────────────

export interface FollowupCandidate {
  address: string;
  first_interaction: string;
  days_since: number;
  already_contacted: boolean;
  already_subscribed: boolean;
}

/**
 * Find users who interacted with the SUBS bot but didn't subscribe,
 * and whose first interaction was >= FOLLOWUP_DELAY_DAYS ago.
 */
export function findFollowupCandidates(): FollowupCandidate[] {
  let db: sqlite3.Database;
  try {
    db = new sqlite3(DB_PATH, { readonly: true });
    db.pragma("journal_mode = WAL");
  } catch {
    return [];
  }

  try {
    const state = loadFollowupState();

    // All unique senders to the SUBS bot
    const allSenders = db.prepare(`
      SELECT DISTINCT account, MIN(timestamp_iso) as first_interaction
      FROM transactions
      WHERE destination = ?
      GROUP BY account
    `).all(SUBS_ADDRESS) as { account: string; first_interaction: string }[];

    // Subscribers (paid >= price)
    const subscribers = new Set(
      (db.prepare(`
        SELECT DISTINCT account FROM transactions
        WHERE destination = ? AND CAST(amount_drops AS INTEGER) >= ?
      `).all(SUBS_ADDRESS, HERALD_PRICE_DROPS) as { account: string }[])
        .map(r => r.account)
    );

    // Also count discounted subscribers (paid >= 900 PFT if they have a discount)
    const discountedSubs = new Set(
      (db.prepare(`
        SELECT DISTINCT account FROM transactions
        WHERE destination = ? AND CAST(amount_drops AS INTEGER) >= ?
      `).all(SUBS_ADDRESS, DISCOUNTED_PRICE * 1_000_000) as { account: string }[])
        .map(r => r.account)
    );

    const now = new Date();
    const candidates: FollowupCandidate[] = [];

    for (const sender of allSenders) {
      // Skip the bot itself
      if (sender.account === SUBS_ADDRESS) continue;

      const firstDate = new Date(sender.first_interaction);
      const daysSince = Math.floor((now.getTime() - firstDate.getTime()) / (86400 * 1000));

      const isSubscribed = subscribers.has(sender.account) || discountedSubs.has(sender.account);
      const isContacted = sender.account in state.contacted;

      candidates.push({
        address: sender.account,
        first_interaction: sender.first_interaction,
        days_since: daysSince,
        already_contacted: isContacted,
        already_subscribed: isSubscribed,
      });
    }

    return candidates;
  } finally {
    db.close();
  }
}

/**
 * Get the list of users who should receive a follow-up offer RIGHT NOW.
 * Criteria: interacted >= 7 days ago, not subscribed, not already contacted.
 */
export function getPendingFollowups(): FollowupCandidate[] {
  return findFollowupCandidates().filter(c =>
    c.days_since >= FOLLOWUP_DELAY_DAYS &&
    !c.already_subscribed &&
    !c.already_contacted
  );
}

/**
 * Generate the follow-up offer message.
 */
export function getFollowupMessage(): string {
  return (
    `We noticed you checked out The Hive Herald but haven't subscribed yet.\n\n` +
    `Special offer: ${DISCOUNT_PFT} PFT off your first month — just ${DISCOUNTED_PRICE} PFT instead of 1000.\n\n` +
    `To subscribe at the discounted rate:\n` +
    `1. Change the PFT amount to ${DISCOUNTED_PRICE}\n` +
    `2. Type /subscribe herald\n` +
    `3. Hit Send\n\n` +
    `This offer expires in 7 days.\n` +
    `pft.permanentupperclass.com/herald/`
  );
}

/**
 * Mark a user as contacted (called after sending the offer).
 */
export function markContacted(address: string, offerType: string = "discount_100"): void {
  const state = loadFollowupState();
  state.contacted[address] = {
    contacted_at: new Date().toISOString(),
    offer_type: offerType,
  };
  saveFollowupState(state);
}

/**
 * Check if an address has a valid discount offer.
 */
export function hasActiveDiscount(address: string): boolean {
  const state = loadFollowupState();
  const contact = state.contacted[address];
  if (!contact) return false;

  // Discount expires 7 days after contact
  const contactDate = new Date(contact.contacted_at);
  const expiryDate = new Date(contactDate);
  expiryDate.setDate(expiryDate.getDate() + 7);

  return new Date() < expiryDate;
}

/**
 * Get the effective price for an address (with discount if applicable).
 */
export function getEffectivePrice(address: string): { price_pft: number; price_drops: number; discounted: boolean } {
  if (hasActiveDiscount(address)) {
    return { price_pft: DISCOUNTED_PRICE, price_drops: DISCOUNTED_PRICE * 1_000_000, discounted: true };
  }
  return { price_pft: 1000, price_drops: HERALD_PRICE_DROPS, discounted: false };
}
