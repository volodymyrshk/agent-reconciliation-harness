# agent-reconciliation-harness

How to let an agent act on a system of record without it writing the wrong thing, or the right thing twice. A small TypeScript reference (not a production library) built around one ugly, common workflow: matching incoming payments to open invoices across inconsistent sources.

An agent that answers a question wrongly is annoying. An agent that posts the wrong ledger entry, or posts it twice because a request timed out after the write, is an incident. The model is the easy part here. The work is everything around it.

## The path every payment takes

```
payment event ──> rules ──decided──────────────────────────┐
                    │                                      │
                    └─ambiguous─> classifier ─> validate ──┤
                                  (model)     (never trust)│
                                                           v
                                                     policy gate
                                                   auto │    │ review
                                                        v    v
                            durable outbox (one action per payment, SQLite)
                                                        │    └─> person decides ─┐
                                                        v                        │
                                   execution-time authority check <──────────────┘
                                                        │
                                                        v
                                     ERP write ── timeout? ──> look it up before any retry
                                                        │
                                                        v
                                               trace for every step
```

1. **Rules first** (`src/rules.ts`). Exact amount, memo reference, rounding within 2 cents, duplicate delivery, no open invoice, currency mismatch, partial and overpayment. Anything a rule can decide with certainty never reaches a model.
2. **A classifier only for what rules can't decide** (`src/classify.ts`). It is an interface: a deterministic heuristic, Claude (`adapters/claude.ts`), or a person. Its output is untrusted JSON. `validate()` only accepts an invoice the classifier was actually shown, from the same tenant and currency, within the rounding tolerance; anything else becomes a review item, never a lookup.
3. **A policy gate** (`src/policy.ts`). Model proposals below 0.9 confidence, and any payment above the auto-apply limit, go to a person whoever proposed them.
4. **A durable outbox** (`src/store.ts`, `src/workflow.ts`). One action per payment, enforced by the database, so a redelivered event or a re-run planner can't create a second write. An action is marked `dispatched` before the ERP call; a worker that dies after that point leaves the outcome unknown, and the next worker treats it as `uncertain` and **looks the write up by reference before it ever posts again**.
5. **Authority at execution time.** The token is checked when the write happens, not when it was planned, so an account disconnected after planning stops the queued write and its retries (`blocked`, for a person to see).
6. **A trace for every step**: workflow version, classifier, model, input hash, decision, confidence, rule, gate, cost, latency, human override.

The fake ERP (`src/erp.ts`) behaves like many real ones: it does not de-duplicate for you, it can time out after it has written, and it only offers a lookup by external reference.

## The demo

`npm run demo`: six payments, two tenants. After planning, one tenant disconnects its ERP account. Then the ERP times out after writing one entry, returns 503 for another, and the worker is killed right after a third write succeeds. A new worker starts from the same database file.

```
5. What the ERP received: one entry per payment, nothing for the revoked tenant, and the payment whose memo pointed at
   another tenant's invoice held as unapplied cash instead.
  northwind:evt_0_8avs9g             apply      INV-7730   199903 EUR
  northwind:evt_0_emjxru             apply      INV-5112   42345 EUR
  northwind:evt_0_sqryg              apply      INV-8874   172275 EUR
  northwind:evt_0_9qim9i             unapplied  -          291429 EUR
  northwind:evt_0_29vacd             apply      INV-6206   399168 EUR
  duplicate writes: 0

6. The trace for northwind:evt_0_emjxru, the write the dead worker never confirmed:
  planned                {"workflow_version":"recon-v1","classifier":"heuristic", ... }
  recovered-as-uncertain {}
  confirmed-by-lookup    {}
```

## The eval

`npm run eval` writes 300 synthetic cases (12 scenarios, 25 each, seeded) to `evals/golden_dataset.jsonl`, each with a known right answer, and scores every classifier configuration on the same set. The number that matters most is how often the system acted and was wrong.

```
                                        rules-only       heuristic        reckless
decided without a person                     50.0%           66.7%           68.7%
correct when it decided                     100.0%          100.0%           82.0%
acted wrongly (of all cases)                  0.0%            0.0%           12.3%
review items that needed review              66.7%          100.0%           79.8%

Where each configuration acted wrongly:
  rules-only         none
  heuristic          none
  reckless           memo-messy 12, ambiguous 25
```

Read this honestly:

- `rules-only` is the safe floor: it never acts wrongly and sends half the work to people.
- `heuristic` is a deterministic stand-in for a model, **written against this generator**, so its perfect score says the harness works, not that the heuristic is good. A real model's score on real data is the point of running this.
- `reckless` picks the first candidate with 0.99 confidence. Validation turned 19 of its wrong picks into reviews (the amounts didn't fit), but in the 25 genuinely ambiguous cases its wrong picks were valid-looking, so the gate let them through. That is what an eval is for: some wrong answers can only be caught by measuring against known outcomes before shipping a configuration.
- With `ANTHROPIC_API_KEY` set and `npm install` run, Claude is added as a fourth column (`CLAUDE_MODEL` to choose the model) with real cost and latency. The numbers above don't include it.

## Properties tested (400 random cases each; replay any failure with `SEED=...`)

- no external write ever happens twice, and every action ends in a known state, under random 503s, timeouts after a write, worker crashes at either dangerous point, and duplicate deliveries
- a revoked token stops queued writes, including retries already scheduled
- nothing crosses tenants: every write uses its own tenant and one of its own invoices
- model output can't pick an invoice it wasn't offered; low confidence or large amounts go to a person (fuzzed with junk and adversarial output)
- delivering the same payment again never creates a second action

Plus regression tests: the naive retry loop writing a timed-out entry twice, the engine writing it once, and the eval catching the reckless classifier.

The tests were checked by breaking the code on purpose, one change at a time:

| Deliberate bug | Tests that fail |
|---|---|
| retry a timed-out write without looking it up | 2 |
| skip crash recovery | 1 |
| drop the tenant filter in the rules | 2 |
| accept any invoice id the model returns | 1 |
| let a model act below the confidence threshold | 1 |
| no uniqueness per payment | 2 |

## Run

Node 23.6 or newer. The core has no dependencies; the Claude adapter is optional.

```bash
npm test
npm run demo
npm run eval
SEED=42 CASES=5000 npm test
```

## Scope

A reference model, about 650 lines of source. In production the outbox is a Postgres table with the same unique key, the workers are a queue consumer, the ERP adapter is per vendor, and the review queue is a UI. Not covered: partial-payment allocation, FX conversion, multi-invoice payments, and real-time concurrency between several workers (the compare-and-set transitions are there, but the tests run one worker at a time). It does not promise exactly-once delivery to a third party; it promises that an uncertain outcome is resolved by looking before writing again, and surfaced when it can't be.

MIT licensed. Volodymyr Shkarban.
