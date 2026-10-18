import { normalizeName, normalizeRef, ROUNDING_TOLERANCE_MINOR } from "./rules.ts";
import type { CaseInput, Invoice, Proposal } from "./types.ts";

// What a classifier sees: one ambiguous payment and the only invoices it may choose from.
export type Question = { input: CaseInput; reason: string; candidates: Invoice[] };

export type ClassifierAnswer = { raw: unknown; model: string; costUsd: number; latencyMs: number };

// A classifier is anything that answers a Question with JSON: a heuristic, Claude, a person.
// Its output is never trusted as-is; see validate().
export interface Classifier {
  name: string;
  classify(q: Question): Promise<ClassifierAnswer>;
}

// The model may only choose among the candidates it was given. An invoice id that wasn't offered
// (hallucinated, or another tenant's) is rejected, not looked up.
export function validate(raw: unknown, q: Question): Proposal {
  const fail = (why: string): Proposal => ({ decision: { kind: "review", reason: `invalid model output: ${why}` }, confidence: 0, source: "model" });
  if (typeof raw !== "object" || raw === null) return fail("not an object");
  const r = raw as Record<string, unknown>;
  const confidence = r.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return fail("confidence must be a number in [0, 1]");
  const rationale = typeof r.rationale === "string" ? r.rationale.slice(0, 500) : undefined;
  switch (r.decision) {
    case "apply": {
      const inv = q.candidates.find((i) => i.id === r.invoice_id);
      if (!inv) return fail(`invoice_id ${JSON.stringify(r.invoice_id)} was not among the candidates`);
      if (inv.tenant !== q.input.payment.tenant || inv.amount.currency !== q.input.payment.amount.currency) return fail("candidate crosses tenant or currency");
      const diff = inv.amount.minor - q.input.payment.amount.minor;
      if (Math.abs(diff) > ROUNDING_TOLERANCE_MINOR) return fail(`amount differs from ${inv.id} by ${diff}`);
      return { decision: { kind: "apply", invoiceId: inv.id, adjustmentMinor: diff }, confidence, source: "model", rationale };
    }
    case "unapplied": return { decision: { kind: "unapplied" }, confidence, source: "model", rationale };
    case "review": return { decision: { kind: "review", reason: rationale ?? "model asked for review" }, confidence, source: "model", rationale };
    default: return fail(`unknown decision ${JSON.stringify(r.decision)}`);
  }
}

// Escalates every ambiguous case. The safe baseline the others are measured against.
export const rulesOnly: Classifier = {
  name: "rules-only",
  async classify() { return { raw: { decision: "review", confidence: 1, rationale: "no classifier configured" }, model: "none", costUsd: 0, latencyMs: 0 }; },
};

// A deterministic stand-in for a model, so the harness runs without an API key. It reads invoice
// numbers out of messy memos and matches near-identical customer names. It is NOT an LLM.
export const heuristic: Classifier = {
  name: "heuristic",
  async classify(q) {
    const memoDigits = (q.input.payment.memo.match(/\d{3,}/g) ?? []);
    const byMemo = q.candidates.filter((i) => memoDigits.some((d) => normalizeRef(i.id).endsWith(d)));
    if (byMemo.length === 1) return answer({ decision: "apply", invoice_id: byMemo[0].id, confidence: 0.95, rationale: "memo carries the invoice number" });
    const ref = normalizeName(q.input.payment.customerRef);
    const byName = q.candidates.filter((i) => similar(ref, normalizeName(customerName(q.input, i.customer))));
    const amountOk = byName.filter((i) => Math.abs(i.amount.minor - q.input.payment.amount.minor) <= ROUNDING_TOLERANCE_MINOR);
    if (amountOk.length === 1) return answer({ decision: "apply", invoice_id: amountOk[0].id, confidence: 0.9, rationale: "payer name matches one customer with one invoice of this amount" });
    return answer({ decision: "review", confidence: 0.5, rationale: "cannot tell candidates apart" });
  },
};

// Applies the first candidate with high confidence. Exists to show the policy gate and the
// eval catching a confident, wrong classifier.
export const reckless: Classifier = {
  name: "reckless",
  async classify(q) {
    const first = q.candidates[0];
    return answer(first ? { decision: "apply", invoice_id: first.id, confidence: 0.99, rationale: "first candidate" } : { decision: "unapplied", confidence: 0.99 });
  },
};

const answer = (raw: unknown): ClassifierAnswer => ({ raw, model: "deterministic", costUsd: 0, latencyMs: 0 });

function customerName(input: CaseInput, customerId: string): string {
  return Object.entries(input.aliases).find(([, id]) => id === customerId)?.[0] ?? customerId;
}

// Same name once suffixes and punctuation are gone ("ACME LTD." vs "Acme Limited").
function similar(a: string, b: string): boolean {
  const strip = (s: string) => s.replace(/(limited|ltd|inc|llc|gmbh|srl|sa)$/g, "");
  return a.length > 2 && strip(a) === strip(b);
}
