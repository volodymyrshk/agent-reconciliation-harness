import type { CaseInput, Invoice } from "./types.ts";

// Synthetic, seeded reconciliation cases with a known right answer. No real data.

export type Truth = { kind: "apply"; invoiceId: string } | { kind: "duplicate" } | { kind: "unapplied" } | { kind: "review" };
export type GoldenCase = { id: string; scenario: Scenario; input: CaseInput; truth: Truth };

export const SCENARIOS = [
  "exact", "rounding", "memo-exact", "memo-messy", "alias-variant", "duplicate",
  "unapplied", "partial", "currency", "ambiguous", "overpayment", "foreign-invoice-leak",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

export function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)];
  const shuffle = <T>(xs: T[]): T[] => { for (let i = xs.length - 1; i > 0; i--) { const j = int(i + 1); [xs[i], xs[j]] = [xs[j], xs[i]]; } return xs; };
  return { next, int, pick, shuffle };
}
export type R = ReturnType<typeof rng>;

const TENANTS: Record<string, Record<string, string>> = {
  "northwind": { "Acme Ltd": "C-100", "Globex Inc": "C-200", "Initech LLC": "C-300", "Umbrella GmbH": "C-400" },
  "contoso": { "Acme Ltd": "C-900", "Stark SRL": "C-910", "Wayne SA": "C-920" },
};
// How payers actually write the names above.
const VARIANTS: Record<string, string> = { "Acme Ltd": "ACME LIMITED", "Globex Inc": "globex, inc.", "Initech LLC": "INITECH", "Umbrella GmbH": "Umbrella G.m.b.H.", "Stark SRL": "STARK S.R.L.", "Wayne SA": "Wayne S.A." };

export function goldenCase(r: R, n: number, scenario: Scenario = r.pick(SCENARIOS)): GoldenCase {
  const tenant = r.pick(Object.keys(TENANTS));
  const aliases = TENANTS[tenant];
  const names = Object.keys(aliases);
  const name = r.pick(names);
  const customer = aliases[name];
  const other = aliases[r.pick(names.filter((x) => x !== name))];
  let seq = 1000 + r.int(8000);
  const inv = (cust: string, minor: number, currency = "EUR", t = tenant): Invoice => ({ tenant: t, id: `INV-${seq++}`, customer: cust, amount: { minor, currency }, status: "open" });
  const amount = 1000 + r.int(400_000);
  const target = inv(customer, amount);
  const filler = [inv(other, amount + 500 + r.int(9000)), inv(other, 1000 + r.int(400_000))];
  const pay = { tenant, id: `evt_${n}_${r.int(1e9).toString(36)}`, customerRef: name, amount: { minor: amount, currency: "EUR" }, memo: r.pick(["thanks", "payment", "", "transfer"]) };
  let invoices: Invoice[] = [target, ...filler];
  let truth: Truth = { kind: "apply", invoiceId: target.id };
  const seenPaymentIds: string[] = [];

  switch (scenario) {
    case "exact": break;
    case "rounding": pay.amount.minor = amount + r.pick([-2, -1, 1, 2]); break;
    case "memo-exact": { const twin = inv(customer, amount); invoices.push(twin); pay.memo = `ref ${target.id}`; break; }
    case "memo-messy": { const twin = inv(customer, amount); invoices.push(twin); pay.memo = `invoice no. ${target.id.slice(4)}`; break; }
    case "alias-variant": { pay.customerRef = VARIANTS[name]; invoices.push(inv(other, amount + 7)); break; }
    case "duplicate": seenPaymentIds.push(pay.id); truth = { kind: "duplicate" }; break;
    case "unapplied": invoices = filler; truth = { kind: "unapplied" }; break;
    case "partial": pay.amount.minor = Math.floor(amount / 2); truth = { kind: "review" }; break;
    case "currency": invoices = [{ ...target, amount: { minor: amount, currency: "USD" } }, ...filler]; truth = { kind: "review" }; break;
    case "ambiguous": invoices.push(inv(customer, amount)); truth = { kind: "review" }; break;
    case "overpayment": pay.amount.minor = amount + 5000 + r.int(5000); invoices = [target, filler[1]]; truth = { kind: "review" }; break;
    case "foreign-invoice-leak": {
      // A buggy context loader hands over another tenant's invoice with the same customer id and amount.
      const foreignTenant = Object.keys(TENANTS).find((t) => t !== tenant)!;
      const leaked = inv(customer, amount, "EUR", foreignTenant);
      invoices = [...filler, leaked];
      pay.memo = `ref ${leaked.id}`;
      truth = { kind: "unapplied" };
      break;
    }
  }
  return { id: `case-${String(n).padStart(4, "0")}`, scenario, input: { payment: pay, invoices: r.shuffle(invoices), aliases: { ...aliases }, seenPaymentIds }, truth };
}

// An even mix of scenarios, so rare-but-dangerous ones are represented.
export function goldenDataset(seed: number, perScenario: number): GoldenCase[] {
  const r = rng(seed);
  const out: GoldenCase[] = [];
  let n = 0;
  for (let k = 0; k < perScenario; k++) for (const s of SCENARIOS) out.push(goldenCase(r, n++, s));
  return out;
}
