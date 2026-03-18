export const config = {
  // XRPL / chain
  botSeed: process.env.BOT_SEED ?? "",
  xrplServer: process.env.XRPL_SERVER ?? "wss://xrplcluster.com",
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? "60000"),

  // scout-api
  scoutApiUrl: process.env.SCOUT_API_URL ?? "http://127.0.0.1:8420",

  // LLM for response formatting
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  model: process.env.LLM_MODEL ?? "claude-3-haiku-20240307",

  // Bot identity
  botName: process.env.BOT_NAME ?? "PF Scout",
  botDescription:
    process.env.BOT_DESCRIPTION ??
    "Contributor discovery and recruitment intelligence for the Post Fiat ecosystem",
};
