/**
 * subs-crm.ts — CRM for Herald subscriber acquisition campaign
 *
 * Tracks:
 * - Outreach: who was messaged, when, trial dates
 * - Engagement: SUBS bot interactions (commands sent)
 * - Conversion: who subscribed after trial
 * - Daily report generation for Telegram updates
 */

import fs from "fs";
import path from "path";
import os from "os";
import sqlite3 from "better-sqlite3";

const CRM_FILE = path.join(os.homedir(), ".pf-scout", "subs-crm.json");
const DB_PATH = process.env.INDEXER_DB_PATH ?? path.join(os.homedir(), ".pf-scout", "chain-index.db");
const SUBS_ADDRESS = "r9XYDxJDbmmhSGNpUguVhea6xn3Tu2HbeF";

// ─── Types ──────────────────────────────────────────────────────────

export interface CRMContact {
  address: string;
  memo_count: number;
  outreach_date: string;
  trial_start: string;
  trial_end: string;
  message_sent: boolean;
  status: "trial_active" | "trial_expired" | "converted" | "churned" | "pending";
  subs_interactions: CRMInteraction[];
  subscribed_at: string | null;
  subscribed_amount: number | null;
}

export interface CRMInteraction {
  timestamp: string;
  type: "services" | "subscribe" | "status" | "help" | "other";
  amount_pft: number;
}

export interface CRMState {
  campaign_name: string;
  campaign_start: string;
  contacts: Record<string, CRMContact>;
  daily_reports: CRMDailyReport[];
}

export interface CRMDailyReport {
  date: string;
  total_contacts: number;
  trials_active: number;
  trials_expired: number;
  converted: number;
  churned: number;
  new_interactions: number;
  report_text: string;
}

// ─── Persistence ────────────────────────────────────────────────────

export function loadCRM(): CRMState {
  try {
    return JSON.parse(fs.readFileSync(CRM_FILE, "utf-8"));
  } catch {
    return {
      campaign_name: "Herald Free Trial — April 2026",
      campaign_start: new Date().toISOString(),
      contacts: {},
      daily_reports: [],
    };
  }
}

export function saveCRM(state: CRMState): void {
  fs.writeFileSync(CRM_FILE, JSON.stringify(state, null, 2));
}

// ─── Contact Management ─────────────────────────────────────────────

export function addContact(
  state: CRMState,
  address: string,
  memoCount: number,
): CRMContact {
  const now = new Date();
  const trialEnd = new Date(now);
  trialEnd.setDate(trialEnd.getDate() + 7);

  const contact: CRMContact = {
    address,
    memo_count: memoCount,
    outreach_date: now.toISOString(),
    trial_start: now.toISOString(),
    trial_end: trialEnd.toISOString(),
    message_sent: false,
    status: "pending",
    subs_interactions: [],
    subscribed_at: null,
    subscribed_amount: null,
  };

  state.contacts[address] = contact;
  return contact;
}

export function markMessageSent(state: CRMState, address: string): void {
  if (state.contacts[address]) {
    state.contacts[address].message_sent = true;
    state.contacts[address].status = "trial_active";
  }
}

// ─── Interaction Tracking ───────────────────────────────────────────

export function recordInteraction(
  state: CRMState,
  address: string,
  type: CRMInteraction["type"],
  amountPft: number = 0,
): void {
  if (!state.contacts[address]) return;
  state.contacts[address].subs_interactions.push({
    timestamp: new Date().toISOString(),
    type,
    amount_pft: amountPft,
  });
}

// ─── Status Updates ─────────────────────────────────────────────────

export function updateStatuses(state: CRMState): void {
  const now = new Date();

  let db: sqlite3.Database;
  try {
    db = new sqlite3(DB_PATH, { readonly: true });
    db.pragma("journal_mode = WAL");
  } catch { return; }

  try {
    for (const [address, contact] of Object.entries(state.contacts)) {
      if (contact.status === "converted") continue;

      // Check if they subscribed (payment >= 900 PFT to SUBS)
      const sub = db.prepare(`
        SELECT timestamp_iso, CAST(amount_drops AS INTEGER)/1000000 as pft
        FROM transactions
        WHERE destination = ? AND account = ?
        AND CAST(amount_drops AS INTEGER) >= 900000000
        AND timestamp_iso > ?
        ORDER BY timestamp_iso DESC LIMIT 1
      `).get(SUBS_ADDRESS, address, contact.outreach_date) as {
        timestamp_iso: string; pft: number;
      } | undefined;

      if (sub) {
        contact.status = "converted";
        contact.subscribed_at = sub.timestamp_iso;
        contact.subscribed_amount = sub.pft;
        continue;
      }

      // Check if they interacted with the SUBS bot since outreach
      const interactions = db.prepare(`
        SELECT timestamp_iso, CAST(amount_drops AS INTEGER)/1000000 as pft
        FROM transactions
        WHERE destination = ? AND account = ?
        AND timestamp_iso > ?
        ORDER BY timestamp_iso
      `).all(SUBS_ADDRESS, address, contact.outreach_date) as {
        timestamp_iso: string; pft: number;
      }[];

      // Record any new interactions not yet tracked
      const tracked = new Set(contact.subs_interactions.map(i => i.timestamp));
      for (const ix of interactions) {
        if (!tracked.has(ix.timestamp_iso)) {
          contact.subs_interactions.push({
            timestamp: ix.timestamp_iso,
            type: ix.pft > 0 ? "subscribe" : "other",
            amount_pft: ix.pft,
          });
        }
      }

      // Update trial status
      const trialEnd = new Date(contact.trial_end);
      if (now > trialEnd) {
        contact.status = "trial_expired";
      } else if (contact.message_sent) {
        contact.status = "trial_active";
      }
    }
  } finally {
    db.close();
  }
}

// ─── Daily Report ───────────────────────────────────────────────────

export function generateDailyReport(state: CRMState): CRMDailyReport {
  const today = new Date().toISOString().substring(0, 10);
  const contacts = Object.values(state.contacts);

  const trialsActive = contacts.filter(c => c.status === "trial_active").length;
  const trialsExpired = contacts.filter(c => c.status === "trial_expired").length;
  const converted = contacts.filter(c => c.status === "converted").length;
  const churned = contacts.filter(c => c.status === "trial_expired" && c.subs_interactions.length === 0).length;
  const pending = contacts.filter(c => c.status === "pending").length;

  // Count interactions today
  const newInteractions = contacts.reduce((sum, c) => {
    return sum + c.subs_interactions.filter(i => i.timestamp.startsWith(today)).length;
  }, 0);

  // Engaged contacts (interacted at least once)
  const engaged = contacts.filter(c => c.subs_interactions.length > 0);

  const lines: string[] = [
    `HERALD CRM — ${today}`,
    ``,
    `Campaign: ${state.campaign_name}`,
    `Total contacts: ${contacts.length}`,
    ``,
    `STATUS:`,
    `  Trial active: ${trialsActive}`,
    `  Trial expired: ${trialsExpired}`,
    `  Converted: ${converted}`,
    `  Pending: ${pending}`,
    `  Churned (expired, no interaction): ${churned}`,
    ``,
    `ENGAGEMENT:`,
    `  New interactions today: ${newInteractions}`,
    `  Total engaged (ever): ${engaged.length}/${contacts.length}`,
    `  Conversion rate: ${contacts.length > 0 ? ((converted / contacts.length) * 100).toFixed(1) : 0}%`,
  ];

  if (converted > 0) {
    lines.push(``, `CONVERSIONS:`);
    for (const c of contacts.filter(c => c.status === "converted")) {
      lines.push(`  ${c.address.substring(0, 6)}...${c.address.slice(-4)} — ${c.subscribed_amount} PFT on ${c.subscribed_at?.substring(0, 10)}`);
    }
  }

  if (engaged.length > 0) {
    lines.push(``, `ENGAGED (interacted with SUBS bot):`);
    for (const c of engaged) {
      const lastIx = c.subs_interactions[c.subs_interactions.length - 1];
      lines.push(`  ${c.address.substring(0, 6)}...${c.address.slice(-4)} — ${c.subs_interactions.length} interaction(s), last: ${lastIx.timestamp.substring(0, 10)}`);
    }
  }

  const report: CRMDailyReport = {
    date: today,
    total_contacts: contacts.length,
    trials_active: trialsActive,
    trials_expired: trialsExpired,
    converted,
    churned,
    new_interactions: newInteractions,
    report_text: lines.join("\n"),
  };

  state.daily_reports.push(report);
  return report;
}
