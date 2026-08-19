/**
 * runner/executor.ts — produce a deliverable for an accepted task, and
 * self-score it. In DRY_RUN it returns a clearly-marked stub so nothing
 * half-real is ever submitted.
 *
 * The self-score gates submission (policy.qualityFloor): an honest "I cannot
 * do this well" abstains rather than submitting low-effort work — the exact
 * behaviour the reward-integrity review wants to see MORE of on the network.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { RunnerConfig } from "./config.js";
import type { TaskOffer } from "./policy.js";

export interface Deliverable {
  text: string;
  selfScore: number;   // 0..1 — model's own confidence it satisfies the brief
  abstained: boolean;
}

const SYSTEM = `You are an autonomous Post Fiat task contributor. You are given a task
brief and must produce a complete, original, submittable deliverable that satisfies the
stated verification. Be concrete and specific — no filler, no restating the prompt. If you
cannot produce genuinely useful, original work for this brief, say so plainly. End your
reply with a final line exactly of the form: SELF_SCORE: <0.00-1.00> reflecting how well
your deliverable satisfies the brief.`;

function parseSelfScore(text: string): { body: string; score: number } {
  const m = text.match(/SELF_SCORE:\s*([0-9]*\.?[0-9]+)/i);
  const score = m ? Math.max(0, Math.min(1, Number(m[1]))) : 0.5;
  const body = text.replace(/SELF_SCORE:\s*[0-9]*\.?[0-9]+\s*$/i, "").trim();
  return { body, score };
}

export async function execute(offer: TaskOffer, cfg: RunnerConfig): Promise<Deliverable> {
  if (cfg.dryRun) {
    return {
      text: `[DRY_RUN] Would generate a deliverable for task ${offer.taskId} ` +
            `(reward ${offer.rewardPft} PFT, verification "${offer.verification}"). ` +
            `Brief: ${offer.brief.slice(0, 140)}…`,
      selfScore: 0.0,
      abstained: true,
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) {
    return { text: "", selfScore: 0, abstained: true };
  }

  const client = new Anthropic({ apiKey });
  const model = process.env.RUNNER_MODEL ?? "claude-opus-4-8";
  const resp = await client.messages.create({
    model,
    max_tokens: 2000,
    system: SYSTEM,
    messages: [{
      role: "user",
      content: `TASK BRIEF:\n${offer.brief}\n\nVERIFICATION REQUIRED: ${offer.verification}\n\nProduce the deliverable now.`,
    }],
  });

  const raw = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  const { body, score } = parseSelfScore(raw);
  return {
    text: body,
    selfScore: score,
    abstained: score < cfg.qualityFloor || body.length < 20,
  };
}
