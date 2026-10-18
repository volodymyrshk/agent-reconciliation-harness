import { createHash } from "node:crypto";
import { validate, type Classifier } from "./classify.ts";
import { Credentials, FakeErp, ForbiddenError, TimeoutError, TransientError } from "./erp.ts";
import { DEFAULT_POLICY, gate, type Gate, type Policy } from "./policy.ts";
import { applyRules } from "./rules.ts";
import type { Action, ActionState, Store } from "./store.ts";
import type { CaseInput, Decision, Proposal } from "./types.ts";

export const WORKFLOW_VERSION = "recon-v1";

export type EngineOptions = {
  tokens: Record<string, string>;        // tenant -> token, looked up at execution time, never cached in the action
  policy?: Policy;
  maxAttempts?: number;
  baseBackoffMs?: number;
  crash?: (point: "after-mark-dispatched" | "after-post") => void;  // test hook: throw to simulate a dying worker
};

export type Planned = { action: Action; proposal: Proposal; gate: Gate; fresh: boolean };

export class Engine {
  store: Store; erp: FakeErp; creds: Credentials; opts: EngineOptions;
  constructor(store: Store, erp: FakeErp, creds: Credentials, opts: EngineOptions) { this.store = store; this.erp = erp; this.creds = creds; this.opts = opts; }

  // Rules -> (classifier -> validation) -> policy gate -> one durable action. No external writes here.
  async plan(input: CaseInput, classifier: Classifier, runId: string, now: number): Promise<Planned> {
    const p = input.payment;
    const key = `${p.tenant}:${p.id}`;
    const inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
    const r = applyRules({ ...input, seenPaymentIds: [...new Set([...input.seenPaymentIds, ...this.store.appliedPaymentIds(p.tenant)])] });
    let proposal: Proposal;
    let model = "none", costUsd = 0, latencyMs = 0;
    if (r.done) {
      proposal = r.proposal;
    } else {
      const q = { input, reason: r.reason, candidates: r.candidates };
      try {
        const ans = await classifier.classify(q);
        ({ model, costUsd, latencyMs } = ans);
        proposal = validate(ans.raw, q);
      } catch (e) {
        proposal = { decision: { kind: "review", reason: `classifier failed: ${(e as Error).message}` }, confidence: 0, source: "model" };
      }
    }
    const g = gate(proposal, p.amount.minor, this.opts.policy ?? DEFAULT_POLICY);
    const d = proposal.decision;
    const state: ActionState = d.kind === "duplicate" ? "skipped" : g.route === "review" ? "review" : "planned";
    const action: Action = {
      key, tenant: p.tenant, paymentId: p.id, kind: d.kind, invoiceId: d.kind === "apply" ? d.invoiceId : null,
      amountMinor: p.amount.minor, adjustmentMinor: d.kind === "apply" ? d.adjustmentMinor : 0, currency: p.amount.currency,
      state, attempts: 0, nextAt: now, lastError: null, source: proposal.source, reason: d.kind === "review" ? d.reason : (g.route === "review" ? g.why : null),
      humanOverride: false, runId,
    };
    const fresh = this.store.insert(action);
    this.store.trace(runId, p.tenant, key, fresh ? "planned" : "duplicate-delivery-ignored", {
      workflow_version: WORKFLOW_VERSION, classifier: classifier.name, model, input_hash: inputHash,
      decision: d, confidence: proposal.confidence, source: proposal.source, rule: proposal.rule ?? null, rationale: proposal.rationale ?? null,
      gate: g, state, latency_ms: latencyMs, cost_usd: costUsd,
    }, now);
    return { action: fresh ? action : this.store.get(key)!, proposal, gate: g, fresh };
  }

  // A worker that died between "dispatched" and "confirmed" leaves the outcome unknown.
  // Treat it as uncertain: check the ERP before ever posting again.
  recover(now: number) {
    for (const a of this.store.all().filter((x) => x.state === "dispatched")) {
      if (this.store.transition(a.key, ["dispatched"], { state: "uncertain", nextAt: now })) this.store.trace(a.runId, a.tenant, a.key, "recovered-as-uncertain", {}, now);
    }
  }

  // Executes every due action once. Safe to call again, from a new process, at any time.
  async drain(now: number): Promise<void> {
    for (const a of this.store.due(now)) {
      const token = this.opts.tokens[a.tenant] ?? "";
      if (a.state === "uncertain") {
        let found;
        try { found = this.erp.findByReference(token, a.tenant, a.key); }
        catch (e) { if (e instanceof ForbiddenError) { this.block(a, e.message, now); continue; } throw e; }
        if (found) {
          if (this.store.transition(a.key, ["uncertain"], { state: "confirmed", lastError: null })) this.store.trace(a.runId, a.tenant, a.key, "confirmed-by-lookup", {}, now);
          continue;
        }
        if (!this.store.transition(a.key, ["uncertain"], { state: "retry" })) continue;
        this.store.trace(a.runId, a.tenant, a.key, "lookup-found-nothing", {}, now);
        a.state = "retry";
      }
      // Authority is checked when the write happens, not when it was planned.
      const denied = this.creds.check(token, a.tenant, "ledger:write");
      if (denied) { this.block(a, denied, now); continue; }
      if (!this.store.transition(a.key, ["planned", "retry"], { state: "dispatched" })) continue;
      this.opts.crash?.("after-mark-dispatched");
      try {
        this.erp.post(token, { tenant: a.tenant, reference: a.key, kind: a.kind as "apply" | "unapplied", invoiceId: a.invoiceId, amountMinor: a.amountMinor, adjustmentMinor: a.adjustmentMinor, currency: a.currency });
        this.opts.crash?.("after-post");
        this.store.transition(a.key, ["dispatched"], { state: "confirmed", lastError: null });
        this.store.trace(a.runId, a.tenant, a.key, "confirmed", { attempt: a.attempts + 1 }, now);
      } catch (e) {
        if (e instanceof TimeoutError) {
          this.store.transition(a.key, ["dispatched"], { state: "uncertain", lastError: e.message, nextAt: now + this.backoff(a.attempts) });
          this.store.trace(a.runId, a.tenant, a.key, "uncertain", { error: e.message }, now);
        } else if (e instanceof TransientError) {
          const attempts = a.attempts + 1;
          const dead = attempts >= (this.opts.maxAttempts ?? 5);
          this.store.transition(a.key, ["dispatched"], { state: dead ? "dead" : "retry", attempts, lastError: e.message, nextAt: now + this.backoff(attempts) });
          this.store.trace(a.runId, a.tenant, a.key, dead ? "dead-letter" : "retry-scheduled", { attempts, error: e.message }, now);
        } else if (e instanceof ForbiddenError) {
          this.store.transition(a.key, ["dispatched"], { state: "blocked", lastError: e.message });
          this.store.trace(a.runId, a.tenant, a.key, "blocked", { error: e.message }, now);
        } else {
          throw e; // a crash: the action stays "dispatched" and recover() turns it into "uncertain"
        }
      }
    }
  }

  // A person resolves a review item. Their decision is recorded as an override and then goes
  // through the same durable path as everything else.
  resolveReview(key: string, decision: Exclude<Decision, { kind: "review" | "duplicate" }>, reviewer: string, now: number): boolean {
    const ok = this.store.transition(key, ["review", "blocked"], {
      state: "planned", kind: decision.kind, invoiceId: decision.kind === "apply" ? decision.invoiceId : null,
      adjustmentMinor: decision.kind === "apply" ? decision.adjustmentMinor : 0, source: "human", humanOverride: true, nextAt: now, lastError: null,
    });
    const a = this.store.get(key);
    if (ok && a) this.store.trace(a.runId, a.tenant, key, "human-resolved", { reviewer, decision }, now);
    return ok;
  }

  private block(a: Action, why: string, now: number) {
    if (this.store.transition(a.key, ["planned", "retry", "uncertain"], { state: "blocked", lastError: why })) this.store.trace(a.runId, a.tenant, a.key, "blocked", { error: why }, now);
  }

  private backoff(attempts: number): number {
    const base = this.opts.baseBackoffMs ?? 1000;
    return Math.min(base * 2 ** attempts, 60_000);
  }
}
