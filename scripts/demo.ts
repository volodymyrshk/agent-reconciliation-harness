// npm run demo: one batch of payments through the whole path, with the failures that matter.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heuristic } from "../src/classify.ts";
import { goldenCase, rng, type Scenario } from "../src/dataset.ts";
import { Credentials, FakeErp, type Fault } from "../src/erp.ts";
import { Store } from "../src/store.ts";
import { Engine } from "../src/workflow.ts";

const dir = mkdtempSync(join(tmpdir(), "recon-"));
const db = join(dir, "outbox.db");
const say = (s: string) => console.log(`\n${s}`);
const states = (store: Store) => store.all().map((a) => `  ${a.key.padEnd(34)} ${a.kind.padEnd(10)} ${a.state.padEnd(10)} ${a.source}${a.humanOverride ? " (human)" : ""}${a.reason ? `  ${a.reason}` : ""}`).join("\n");

const creds = new Credentials();
const tokens = { northwind: "tok-nw", contoso: "tok-co" };
creds.issue(tokens.northwind, "northwind", ["ledger:write", "ledger:read"]);
creds.issue(tokens.contoso, "contoso", ["ledger:write", "ledger:read"]);

// The ERP times out after writing the first entry and is briefly down for the second.
const script: Fault[] = ["timeout-after-write", "fail-before-write"];
const erp = new FakeErp(creds, () => script.shift() ?? "ok");

const r = rng(11);
const pick = (s: Scenario, tenant: string) => { for (;;) { const c = goldenCase(r, 0, s); if (c.input.payment.tenant === tenant) return c; } };
const batch = [pick("exact", "northwind"), pick("rounding", "northwind"), pick("memo-messy", "northwind"), pick("ambiguous", "northwind"), pick("exact", "contoso"), pick("foreign-invoice-leak", "northwind")];

say("1. Plan: rules first, the heuristic classifier only for what rules can't decide, then the policy gate. Nothing is written yet.");
let store = new Store(db);
let crashNext = true;
const worker = () => new Engine(store, erp, creds, { tokens, baseBackoffMs: 500, crash: (point) => { if (point === "after-post" && crashNext && store.get(batch[2].input.payment.tenant + ":" + batch[2].input.payment.id)?.state === "dispatched") { crashNext = false; throw new Error("worker killed right after the ERP accepted the write"); } } });
let engine = worker();
for (const c of batch) await engine.plan(c.input, heuristic, "demo", 0);
await engine.plan(batch[0].input, heuristic, "demo-redelivery", 0); // the provider delivers one event twice
console.log(states(store));

say("2. Contoso disconnects its ERP account after its payment was planned. Then execute: the ERP times out after writing one entry,\n   returns 503 for another, and the worker dies right after a third write succeeds.");
creds.revoke(tokens.contoso);
try { await engine.drain(0); } catch (e) { console.log(`  !! ${(e as Error).message}`); }
console.log(states(store));

say("3. A new worker starts from the same database. Anything left 'dispatched' becomes 'uncertain' and is looked up in the ERP before any retry.");
store = new Store(db);
engine = worker();
engine.recover(1000);
await engine.drain(1000);
await engine.drain(5000);
console.log(states(store));

say("4. A person resolves the review item the classifier couldn't tell apart.");
const review = store.all().find((a) => a.state === "review" && a.reason?.includes("cannot tell"))!;
const c = batch.find((x) => `${x.input.payment.tenant}:${x.input.payment.id}` === review.key)!;
const chosen = c.input.invoices.find((i) => i.customer === c.input.aliases[c.input.payment.customerRef] && i.amount.minor === c.input.payment.amount.minor)!;
engine.resolveReview(review.key, { kind: "apply", invoiceId: chosen.id, adjustmentMinor: 0 }, "finance-ops@northwind", 6000);
await engine.drain(6000);
console.log(states(store));

say("5. What the ERP received: one entry per payment, nothing for the revoked tenant, and the payment whose memo pointed at\n   another tenant's invoice held as unapplied cash instead.");
for (const e of erp.entries) console.log(`  ${e.reference.padEnd(34)} ${e.kind.padEnd(10)} ${String(e.invoiceId ?? "-").padEnd(10)} ${e.amountMinor} ${e.currency}`);
const dupes = store.all().filter((a) => erp.writesFor(a.key) > 1).length;
console.log(`  duplicate writes: ${dupes}`);

const crashed = `${batch[2].input.payment.tenant}:${batch[2].input.payment.id}`;
say(`6. The trace for ${crashed}, the write the dead worker never confirmed:`);
for (const t of store.traces(crashed)) console.log(`  ${t.step.padEnd(22)} ${JSON.stringify(t.data).slice(0, 150)}`);
rmSync(dir, { recursive: true, force: true });
