import { test } from "node:test";
import assert from "node:assert/strict";
import { heuristic, validate, type Question } from "../src/classify.ts";
import { goldenCase, rng, type GoldenCase, type R } from "../src/dataset.ts";
import { Credentials, FakeErp, type Fault } from "../src/erp.ts";
import { DEFAULT_POLICY, gate } from "../src/policy.ts";
import { Store } from "../src/store.ts";
import type { Proposal } from "../src/types.ts";
import { Engine } from "../src/workflow.ts";

// Replay any failure: SEED=1234 npm test. More cases: CASES=5000 npm test.
const SEED = Number(process.env.SEED ?? 1);
const CASES = Number(process.env.CASES ?? 400);
const TERMINAL = new Set(["confirmed", "review", "blocked", "dead", "skipped"]);
class Crash extends Error {}

function world(r: R, crashRate = 0.2) {
  const creds = new Credentials();
  const tokens = { northwind: "tok-nw", contoso: "tok-co" };
  for (const [tenant, tok] of Object.entries(tokens)) creds.issue(tok, tenant, ["ledger:write", "ledger:read"]);
  const fault = (): Fault => r.pick(["ok", "ok", "fail-before-write", "timeout-after-write"] as const);
  const erp = new FakeErp(creds, fault);
  const store = new Store();
  const crash = () => { if (r.next() < crashRate) throw new Crash("worker died"); };
  const engine = () => new Engine(store, erp, creds, { tokens, crash, maxAttempts: 8, baseBackoffMs: 10 });
  return { creds, tokens, erp, store, engine };
}

// Plan a batch (with one payment delivered twice), then run workers until nothing is due,
// replacing the worker every time one "dies".
async function run(r: R, w: ReturnType<typeof world>, onTick?: (tick: number) => void) {
  const cases: GoldenCase[] = Array.from({ length: 1 + r.int(6) }, (_, i) => goldenCase(r, i));
  let e = w.engine();
  for (const c of cases) await e.plan(c.input, heuristic, "run", 0);
  if (cases.length) await e.plan(r.pick(cases).input, heuristic, "redelivery", 0);
  let now = 0;
  for (let tick = 0; tick < 400; tick++) {
    onTick?.(tick);
    try { await e.drain(now); }
    catch (err) { if (!(err instanceof Crash)) throw err; e = w.engine(); e.recover(now); }
    now += 1000;
    if (w.store.all().every((a) => TERMINAL.has(a.state))) break;
  }
  return cases;
}

test("no external write ever happens twice, and every action ends in a known state", async () => {
  for (let i = 0; i < CASES; i++) {
    const r = rng(SEED * 100_003 + i);
    const w = world(r);
    await run(r, w);
    for (const a of w.store.all()) {
      const writes = w.erp.writesFor(a.key);
      assert.ok(TERMINAL.has(a.state), `case ${i}: ${a.key} stuck in ${a.state}`);
      assert.ok(writes <= 1, `case ${i}: ${a.key} written ${writes} times`);
      assert.equal(writes, a.state === "confirmed" ? 1 : 0, `case ${i}: ${a.key} is ${a.state} with ${writes} writes`);
    }
  }
});

test("a revoked token stops queued writes, including retries already scheduled", async () => {
  for (let i = 0; i < CASES; i++) {
    const r = rng(SEED * 200_003 + i);
    const w = world(r);
    const revokeAt = r.int(4);
    let writesAtRevocation = -1;
    await run(r, w, (tick) => { if (tick === revokeAt) { w.creds.revoke(w.tokens.northwind); writesAtRevocation = w.erp.entries.length; } });
    if (writesAtRevocation < 0) continue;
    const after = w.erp.entries.slice(writesAtRevocation).filter((e) => e.tenant === "northwind");
    assert.equal(after.length, 0, `case ${i}: northwind wrote after revocation`);
  }
});

test("nothing crosses tenants: every write uses its own tenant and one of its own invoices", async () => {
  for (let i = 0; i < CASES; i++) {
    const r = rng(SEED * 300_007 + i);
    const w = world(r, 0);
    const cases = await run(r, w);
    for (const e of w.erp.entries) {
      const c = cases.find((x) => `${x.input.payment.tenant}:${x.input.payment.id}` === e.reference)!;
      assert.equal(e.tenant, c.input.payment.tenant);
      if (e.invoiceId) {
        const inv = c.input.invoices.find((x) => x.id === e.invoiceId);
        assert.ok(inv && inv.tenant === e.tenant, `case ${i}: wrote against ${e.invoiceId} from another tenant`);
      }
    }
  }
});

test("model output can't pick an invoice it wasn't offered, and low confidence or large amounts go to a person", () => {
  const r = rng(SEED * 400_009);
  const junk = () => r.pick<unknown>([null, 7, "apply", [], {}, { decision: "apply" }, { decision: "apply", invoice_id: "INV-0000", confidence: 0.99 },
    { decision: "apply", invoice_id: 42, confidence: 1 }, { decision: "delete_everything", confidence: 1 }, { decision: "apply", confidence: Number.NaN }]);
  for (let i = 0; i < CASES * 5; i++) {
    const c = goldenCase(r, i);
    const q: Question = { input: c.input, reason: "fuzz", candidates: c.input.invoices.filter(() => r.next() < 0.5) };
    const pickId = r.next() < 0.5 && c.input.invoices.length ? r.pick(c.input.invoices).id : `INV-${r.int(99999)}`;
    const raw = r.next() < 0.5 ? junk() : { decision: r.pick(["apply", "unapplied", "review"]), invoice_id: pickId, confidence: r.next() * 1.2 - 0.1 };
    const p: Proposal = validate(raw, q);
    if (p.decision.kind === "apply") {
      const id = p.decision.invoiceId;
      const inv = q.candidates.find((x) => x.id === id);
      assert.ok(inv, `apply chose ${id}, which was not offered`);
      assert.equal(inv.tenant, c.input.payment.tenant);
    }
    const amount = r.pick([100, 499_999, 500_001, 9_000_000]);
    const g = gate(p, amount, DEFAULT_POLICY);
    if (g.route === "auto" && p.decision.kind !== "duplicate") {
      assert.ok(amount <= DEFAULT_POLICY.autoApplyLimitMinor);
      assert.ok(p.confidence >= DEFAULT_POLICY.minModelConfidence);
    }
  }
});

test("delivering the same payment again never creates a second action", async () => {
  for (let i = 0; i < CASES; i++) {
    const r = rng(SEED * 500_009 + i);
    const w = world(r, 0);
    const c = goldenCase(r, i);
    const first = await w.engine().plan(c.input, heuristic, "a", 0);
    const again = await w.engine().plan(c.input, heuristic, "b", 0);
    assert.equal(again.fresh, false);
    assert.equal(w.store.all().length, 1);
    assert.deepEqual(w.store.get(first.action.key)?.state, first.action.state);
  }
});
