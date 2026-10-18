import type { Classifier } from "./classify.ts";
import type { GoldenCase } from "./dataset.ts";
import { Credentials, FakeErp } from "./erp.ts";
import type { Policy } from "./policy.ts";
import { Store } from "./store.ts";
import { Engine } from "./workflow.ts";

export type Outcome = "correct-auto" | "false-auto" | "correct-review" | "deferred";

export type Report = {
  config: string; cases: number;
  autoRate: number;            // share decided without a person
  autoPrecision: number;       // of those, share that were right
  falseAutoRate: number;       // share of all cases acted on wrongly: the number that matters most
  escalationPrecision: number; // share of review items that truly needed a person
  costUsd: number; p50LatencyMs: number; p95LatencyMs: number;
  byScenario: Record<string, Record<Outcome, number>>;
  falseAutos: { id: string; scenario: string; got: string; want: string }[];
};

// Plans every golden case (no external writes) and scores the decision the system would act on.
export async function evaluate(config: string, classifier: Classifier, cases: GoldenCase[], policy?: Policy): Promise<Report> {
  const counts: Record<Outcome, number> = { "correct-auto": 0, "false-auto": 0, "correct-review": 0, deferred: 0 };
  const byScenario: Report["byScenario"] = {};
  const falseAutos: Report["falseAutos"] = [];
  const latencies: number[] = [];
  let costUsd = 0;
  for (const c of cases) {
    const store = new Store();
    const creds = new Credentials();
    const engine = new Engine(store, new FakeErp(creds), creds, { tokens: {}, policy });
    const { action, gate } = await engine.plan(c.input, classifier, `eval-${config}`, 0);
    const t = store.traces(action.key).find((x) => x.step === "planned")?.data as { latency_ms: number; cost_usd: number };
    latencies.push(t.latency_ms); costUsd += t.cost_usd;
    const auto = action.state === "planned" || action.state === "skipped";
    const got = auto ? (action.kind === "apply" ? `apply ${action.invoiceId}` : action.kind) : "review";
    const want = c.truth.kind === "apply" ? `apply ${c.truth.invoiceId}` : c.truth.kind;
    const o: Outcome = auto ? (got === want ? "correct-auto" : "false-auto") : (c.truth.kind === "review" ? "correct-review" : "deferred");
    counts[o]++;
    (byScenario[c.scenario] ??= { "correct-auto": 0, "false-auto": 0, "correct-review": 0, deferred: 0 })[o]++;
    if (o === "false-auto") falseAutos.push({ id: c.id, scenario: c.scenario, got, want });
    void gate;
  }
  const n = cases.length, autos = counts["correct-auto"] + counts["false-auto"], reviews = counts["correct-review"] + counts.deferred;
  const sorted = [...latencies].sort((a, b) => a - b);
  const pct = (q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
  return {
    config, cases: n,
    autoRate: autos / n, autoPrecision: autos ? counts["correct-auto"] / autos : 1, falseAutoRate: counts["false-auto"] / n,
    escalationPrecision: reviews ? counts["correct-review"] / reviews : 1,
    costUsd, p50LatencyMs: pct(0.5), p95LatencyMs: pct(0.95), byScenario, falseAutos,
  };
}

export function table(reports: Report[]): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const rows: [string, (r: Report) => string][] = [
    ["decided without a person", (r) => pct(r.autoRate)],
    ["correct when it decided", (r) => pct(r.autoPrecision)],
    ["acted wrongly (of all cases)", (r) => pct(r.falseAutoRate)],
    ["review items that needed review", (r) => pct(r.escalationPrecision)],
    ["model cost (USD)", (r) => r.costUsd.toFixed(4)],
    ["model latency p50 / p95 (ms)", (r) => `${Math.round(r.p50LatencyMs)} / ${Math.round(r.p95LatencyMs)}`],
  ];
  const w = 34, cw = Math.max(16, ...reports.map((r) => r.config.length + 2));
  const lines = ["".padEnd(w) + reports.map((r) => r.config.padStart(cw)).join("")];
  for (const [label, f] of rows) lines.push(label.padEnd(w) + reports.map((r) => f(r).padStart(cw)).join(""));
  return lines.join("\n");
}
