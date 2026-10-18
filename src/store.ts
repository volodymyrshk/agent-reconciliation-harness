import { DatabaseSync } from "node:sqlite";

// planned -> dispatched -> confirmed
//                 \-> uncertain (timeout or crash after dispatch) -> lookup -> confirmed | retry
// retry -> dispatched ... -> dead after max attempts
// blocked: authority was missing or revoked at execution time. review: waiting for a person.
// skipped: nothing to write (duplicate delivery).
export type ActionState = "planned" | "dispatched" | "uncertain" | "retry" | "confirmed" | "blocked" | "dead" | "review" | "skipped";

export type Action = {
  key: string;            // `${tenant}:${paymentId}`: one action per payment, ever. Also the ERP reference.
  tenant: string;
  paymentId: string;
  kind: "apply" | "unapplied" | "duplicate" | "review";
  invoiceId: string | null;
  amountMinor: number;
  adjustmentMinor: number;
  currency: string;
  state: ActionState;
  attempts: number;
  nextAt: number;
  lastError: string | null;
  source: string;         // rule | model | human
  reason: string | null;
  humanOverride: boolean;
  runId: string;
};

export class Store {
  db: DatabaseSync;
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS actions (
        key TEXT PRIMARY KEY, tenant TEXT NOT NULL, payment_id TEXT NOT NULL, kind TEXT NOT NULL,
        invoice_id TEXT, amount_minor INTEGER NOT NULL, adjustment_minor INTEGER NOT NULL, currency TEXT NOT NULL,
        state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT, source TEXT NOT NULL, reason TEXT, human_override INTEGER NOT NULL DEFAULT 0, run_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS traces (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, tenant TEXT NOT NULL, action_key TEXT NOT NULL,
        step TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL);`);
  }

  // Returns false if this payment already has an action: re-planning can never create a second write.
  insert(a: Action): boolean {
    const r = this.db.prepare(`INSERT OR IGNORE INTO actions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      a.key, a.tenant, a.paymentId, a.kind, a.invoiceId, a.amountMinor, a.adjustmentMinor, a.currency,
      a.state, a.attempts, a.nextAt, a.lastError, a.source, a.reason, a.humanOverride ? 1 : 0, a.runId);
    return r.changes === 1;
  }

  // Compare-and-set on state, so two workers (or a worker and a reviewer) can't both move an action.
  transition(key: string, from: ActionState[], patch: Partial<Pick<Action, "state" | "attempts" | "nextAt" | "lastError" | "kind" | "invoiceId" | "adjustmentMinor" | "source" | "reason" | "humanOverride">>): boolean {
    const cols: string[] = []; const vals: (string | number | null)[] = [];
    const map: Record<string, string> = { state: "state", attempts: "attempts", nextAt: "next_at", lastError: "last_error", kind: "kind", invoiceId: "invoice_id", adjustmentMinor: "adjustment_minor", source: "source", reason: "reason", humanOverride: "human_override" };
    for (const [k, v] of Object.entries(patch)) { cols.push(`${map[k]} = ?`); vals.push(typeof v === "boolean" ? (v ? 1 : 0) : (v as string | number | null)); }
    const r = this.db.prepare(`UPDATE actions SET ${cols.join(", ")} WHERE key = ? AND state IN (${from.map(() => "?").join(",")})`).run(...vals, key, ...from);
    return r.changes === 1;
  }

  get(key: string): Action | undefined { const row = this.db.prepare(`SELECT * FROM actions WHERE key = ?`).get(key); return row ? toAction(row) : undefined; }
  all(): Action[] { return this.db.prepare(`SELECT * FROM actions ORDER BY key`).all().map(toAction); }
  due(now: number): Action[] {
    return this.db.prepare(`SELECT * FROM actions WHERE state IN ('planned','uncertain','retry') AND next_at <= ? ORDER BY next_at, key`).all(now).map(toAction);
  }
  appliedPaymentIds(tenant: string): string[] {
    return this.db.prepare(`SELECT payment_id FROM actions WHERE tenant = ? AND kind IN ('apply','unapplied') AND state = 'confirmed'`).all(tenant).map((r) => String((r as { payment_id: string }).payment_id));
  }

  trace(runId: string, tenant: string, actionKey: string, step: string, data: Record<string, unknown>, at: number) {
    this.db.prepare(`INSERT INTO traces (run_id, tenant, action_key, step, data, at) VALUES (?,?,?,?,?,?)`).run(runId, tenant, actionKey, step, JSON.stringify(data), at);
  }
  traces(actionKey?: string) {
    const rows = actionKey ? this.db.prepare(`SELECT * FROM traces WHERE action_key = ? ORDER BY seq`).all(actionKey) : this.db.prepare(`SELECT * FROM traces ORDER BY seq`).all();
    return rows.map((r) => { const t = r as Record<string, unknown>; return { ...t, data: JSON.parse(String(t.data)) }; });
  }
}

function toAction(row: unknown): Action {
  const r = row as Record<string, unknown>;
  return {
    key: String(r.key), tenant: String(r.tenant), paymentId: String(r.payment_id), kind: r.kind as Action["kind"],
    invoiceId: r.invoice_id === null ? null : String(r.invoice_id), amountMinor: Number(r.amount_minor), adjustmentMinor: Number(r.adjustment_minor),
    currency: String(r.currency), state: r.state as ActionState, attempts: Number(r.attempts), nextAt: Number(r.next_at),
    lastError: r.last_error === null ? null : String(r.last_error), source: String(r.source), reason: r.reason === null ? null : String(r.reason),
    humanOverride: Number(r.human_override) === 1, runId: String(r.run_id),
  };
}
