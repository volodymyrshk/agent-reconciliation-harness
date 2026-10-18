import { test } from "node:test";
import assert from "node:assert/strict";
import { heuristic, reckless, rulesOnly } from "../src/classify.ts";
import { goldenCase, goldenDataset, rng } from "../src/dataset.ts";
import { Credentials, FakeErp, TimeoutError, type Entry, type Fault } from "../src/erp.ts";
import { evaluate } from "../src/eval.ts";
import { Store } from "../src/store.ts";
import { Engine } from "../src/workflow.ts";

function setup(faults: Fault[]) {
  const creds = new Credentials();
  creds.issue("tok", "northwind", ["ledger:write", "ledger:read"]);
  let n = 0;
  const erp = new FakeErp(creds, () => faults[n++] ?? "ok");
  return { creds, erp };
}

const entry: Entry = { tenant: "northwind", reference: "northwind:evt_1", kind: "apply", invoiceId: "INV-1", amountMinor: 1000, adjustmentMinor: 0, currency: "EUR" };

test("the failure class: retrying a timed-out write without checking writes it twice", () => {
  const { erp } = setup(["timeout-after-write", "ok"]);
  // The usual retry loop: a timeout looks like a failure, so post again.
  for (let attempt = 0; attempt < 3; attempt++) {
    try { erp.post("tok", entry); break; } catch (e) { if (!(e instanceof TimeoutError)) throw e; }
  }
  assert.equal(erp.writesFor(entry.reference), 2);
});

test("the engine looks the write up before retrying, so the same timeout writes once", async () => {
  const { creds, erp } = setup(["timeout-after-write", "ok"]);
  const store = new Store();
  const engine = new Engine(store, erp, creds, { tokens: { northwind: "tok" }, baseBackoffMs: 1 });
  const r = rng(3);
  const c = goldenCase(r, 0, "exact");
  c.input.payment.tenant = "northwind";
  for (const i of c.input.invoices) i.tenant = "northwind";
  const { action } = await engine.plan(c.input, rulesOnly, "run", 0);
  for (let now = 0; now < 10_000; now += 1000) await engine.drain(now);
  assert.equal(store.get(action.key)?.state, "confirmed");
  assert.equal(erp.writesFor(action.key), 1);
  assert.deepEqual(store.traces(action.key).map((t) => t.step), ["planned", "uncertain", "confirmed-by-lookup"]);
});

test("on the golden dataset, a confident wrong classifier is caught by the eval, the safe ones act wrongly 0 times", async () => {
  const cases = goldenDataset(7, 10);
  const [safe, heur, wild] = await Promise.all([evaluate("rules-only", rulesOnly, cases), evaluate("heuristic", heuristic, cases), evaluate("reckless", reckless, cases)]);
  assert.equal(safe.falseAutoRate, 0);
  assert.equal(heur.falseAutoRate, 0);
  assert.ok(heur.autoRate > safe.autoRate, "the heuristic should decide more cases than rules alone");
  assert.ok(wild.falseAutoRate > 0, "the reckless classifier should be caught acting wrongly");
});
