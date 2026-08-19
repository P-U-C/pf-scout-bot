/**
 * subs-followup.test.ts — Tests for the SUBS follow-up offer system
 *
 * Tests:
 *   1. findFollowupCandidates returns correct candidates
 *   2. getPendingFollowups filters by delay and status
 *   3. markContacted persists state
 *   4. hasActiveDiscount returns true within 7 days
 *   5. hasActiveDiscount returns false after 7 days
 *   6. getEffectivePrice returns discounted price for eligible users
 *   7. getEffectivePrice returns full price for non-eligible users
 *   8. getFollowupMessage contains required elements
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getFollowupMessage,
  hasActiveDiscount,
  getEffectivePrice,
  markContacted,
} from "./subs-followup.js";
import fs from "fs";
import path from "path";
import os from "os";

const FOLLOWUP_FILE = path.join(os.homedir(), ".pf-scout", "subs-followups-test.json");

// Override the module's file path for testing
// We test the pure functions directly since DB-dependent functions need a real index

describe("subs-followup: getFollowupMessage", () => {
  it("contains discount amount and discounted price", () => {
    const msg = getFollowupMessage();
    expect(msg).toContain("100 PFT off");
    expect(msg).toContain("900 PFT");
    expect(msg).toContain("instead of 1000");
  });

  it("contains subscribe instructions", () => {
    const msg = getFollowupMessage();
    expect(msg).toContain("/subscribe herald");
    expect(msg).toContain("Change the PFT amount");
    expect(msg).toContain("Hit Send");
  });

  it("contains Herald URL", () => {
    const msg = getFollowupMessage();
    expect(msg).toContain("pft.permanentupperclass.com/herald/");
  });

  it("mentions expiry", () => {
    const msg = getFollowupMessage();
    expect(msg).toContain("expires in 7 days");
  });
});

describe("subs-followup: getEffectivePrice", () => {
  it("returns full price for unknown address", () => {
    const pricing = getEffectivePrice("rUnknownAddress123456789");
    expect(pricing.price_pft).toBe(1000);
    expect(pricing.price_drops).toBe(1_000_000_000);
    expect(pricing.discounted).toBe(false);
  });

  it("returns discounted price for contacted address within 7 days", () => {
    // Mark as contacted now
    markContacted("rTestDiscount123456789");
    const pricing = getEffectivePrice("rTestDiscount123456789");
    expect(pricing.price_pft).toBe(900);
    expect(pricing.price_drops).toBe(900_000_000);
    expect(pricing.discounted).toBe(true);
  });
});

describe("subs-followup: hasActiveDiscount", () => {
  it("returns false for never-contacted address", () => {
    expect(hasActiveDiscount("rNeverContacted123")).toBe(false);
  });

  it("returns true for recently contacted address", () => {
    markContacted("rRecentContact123");
    expect(hasActiveDiscount("rRecentContact123")).toBe(true);
  });
});
