export interface InboundMessage {
  txHash: string;
  sender: string;       // XRPL r-address
  content: string;      // decrypted / plain-text message body
  ledgerIndex: number;
  timestampIso: string;
  amountDrops: string;  // PFT amount in drops attached to the transaction
}

export interface ScoutQuery {
  type: "search" | "profile" | "list" | "richlist" | "help" | "stats" | "infra" | "tag" | "whales" | "active" | "connections" | "check" | "pulse" | "earners" | "network" | "sybil_check" | "subs_services" | "subs_status";
  query?: string;
  identifier?: string;  // for profile lookups (handle, r-address, …)
  tier?: string;
  limit?: number;
  rubric?: string;
  params?: Record<string, string>; // extra params passed through to scout-api (e.g. requester_wallet)
}

export interface ScoutResult {
  raw: unknown;         // raw scout-api response
  formatted: string;    // LLM-formatted response for the user
}
