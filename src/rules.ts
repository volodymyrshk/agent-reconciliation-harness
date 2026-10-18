import type { CaseInput, Invoice, Proposal } from "./types.ts";

// Rounding differences a payer can legitimately produce (FX display rounding, fee splits).
export const ROUNDING_TOLERANCE_MINOR = 2;

export const normalizeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export const normalizeRef = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

// Map the payer's free-text reference to an ERP customer through this tenant's alias table.
export function resolveCustomer(c: CaseInput): string | null {
  const exact = c.aliases[c.payment.customerRef];
  if (exact) return exact;
  return null;
}

export type RuleResult =
  | { done: true; proposal: Proposal }
  | { done: false; reason: string; candidates: Invoice[] };

// Deterministic first. Anything a rule can decide with certainty never reaches a model.
export function applyRules(c: CaseInput): RuleResult {
  const p = c.payment;
  const rule = (name: string, decision: Proposal["decision"]): RuleResult =>
    ({ done: true, proposal: { decision, confidence: 1, source: "rule", rule: name } });

  if (!Number.isInteger(p.amount.minor) || p.amount.minor <= 0) return rule("invalid-amount", { kind: "review", reason: "amount is not a positive integer" });
  if (c.seenPaymentIds.includes(p.id)) return rule("provider-id-seen", { kind: "duplicate" });

  const open = c.invoices.filter((i) => i.tenant === p.tenant && i.status === "open");
  const customer = resolveCustomer(c);
  if (customer === null) {
    return { done: false, reason: "unknown-customer", candidates: open.filter((i) => i.amount.currency === p.amount.currency) };
  }

  const mine = open.filter((i) => i.customer === customer);
  const sameCcy = mine.filter((i) => i.amount.currency === p.amount.currency);
  if (mine.length > 0 && sameCcy.length === 0) return rule("currency-mismatch", { kind: "review", reason: "payment currency differs from every open invoice" });
  if (sameCcy.length === 0) return rule("no-open-invoice", { kind: "unapplied" });

  const memo = normalizeRef(p.memo);
  const byMemo = sameCcy.filter((i) => memo.includes(normalizeRef(i.id)));
  if (byMemo.length === 1) {
    const inv = byMemo[0];
    const diff = p.amount.minor - inv.amount.minor;
    if (Math.abs(diff) <= ROUNDING_TOLERANCE_MINOR) return rule("memo-reference", { kind: "apply", invoiceId: inv.id, adjustmentMinor: -diff });
    return rule("memo-amount-mismatch", { kind: "review", reason: `memo names ${inv.id} but the amount differs by ${diff}` });
  }

  const exact = sameCcy.filter((i) => i.amount.minor === p.amount.minor);
  if (exact.length === 1) return rule("exact-amount", { kind: "apply", invoiceId: exact[0].id, adjustmentMinor: 0 });
  if (exact.length > 1) return { done: false, reason: "several-invoices-same-amount", candidates: exact };

  const near = sameCcy.filter((i) => Math.abs(i.amount.minor - p.amount.minor) <= ROUNDING_TOLERANCE_MINOR);
  if (near.length === 1) return rule("rounding", { kind: "apply", invoiceId: near[0].id, adjustmentMinor: near[0].amount.minor - p.amount.minor });

  if (sameCcy.some((i) => p.amount.minor < i.amount.minor)) return rule("partial-payment", { kind: "review", reason: "smaller than every candidate invoice; partial payments need a person" });
  return rule("overpayment", { kind: "review", reason: "larger than every candidate invoice" });
}
