export interface InboundMessage {
  txHash: string;
  sender: string;       // XRPL r-address
  content: string;      // decrypted / plain-text message body
  ledgerIndex: number;
  timestampIso: string;
}

export interface ScoutQuery {
  type: "search" | "profile" | "list" | "help";
  query?: string;
  identifier?: string;  // for profile lookups (handle, r-address, …)
  tier?: string;
  limit?: number;
  rubric?: string;
}

export interface ScoutResult {
  raw: unknown;         // raw scout-api response
  formatted: string;    // LLM-formatted response for the user
}
