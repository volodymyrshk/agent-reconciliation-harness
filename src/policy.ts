import type { Proposal } from "./types.ts";

export type Policy = {
  minModelConfidence: number;   // model proposals below this go to a person
  autoApplyLimitMinor: number;  // payments above this always go to a person
};

export const DEFAULT_POLICY: Policy = { minModelConfidence: 0.9, autoApplyLimitMinor: 500_000 };

export type Gate = { route: "auto" | "review"; why: string };

// Decides whether a proposal may act without a human. Rules decided with certainty; a model
// guessed. Writes above the limit always need a person, whoever proposed them.
export function gate(p: Proposal, amountMinor: number, policy: Policy = DEFAULT_POLICY): Gate {
  const d = p.decision;
  if (d.kind === "review") return { route: "review", why: d.reason };
  if (d.kind === "duplicate") return { route: "auto", why: "duplicate delivery: no write" };
  if (amountMinor > policy.autoApplyLimitMinor) return { route: "review", why: `amount above auto-apply limit ${policy.autoApplyLimitMinor}` };
  if (p.source === "model" && p.confidence < policy.minModelConfidence) return { route: "review", why: `model confidence ${p.confidence} below ${policy.minModelConfidence}` };
  return { route: "auto", why: p.source === "rule" ? `rule ${p.rule}` : `model confidence ${p.confidence}` };
}
