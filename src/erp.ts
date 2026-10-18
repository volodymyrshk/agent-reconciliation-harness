// A fake ERP write API with the failure modes real ones have. Like many ERPs, it does NOT
// de-duplicate on our behalf: posting the same entry twice creates two entries. The only help
// it offers is a lookup by our external reference.

export class TransientError extends Error { name = "TransientError"; }   // 503 before anything was written
export class TimeoutError extends Error { name = "TimeoutError"; }       // we gave up; the write may or may not exist
export class ForbiddenError extends Error { name = "ForbiddenError"; }   // token revoked or wrong tenant

export type Entry = { tenant: string; reference: string; kind: "apply" | "unapplied"; invoiceId: string | null; amountMinor: number; adjustmentMinor: number; currency: string };
export type Fault = "ok" | "fail-before-write" | "timeout-after-write";

type Grant = { tenant: string; scopes: Set<string>; revoked: boolean };

// Tokens the ERP issued. Revocation takes effect immediately, including for jobs already queued.
export class Credentials {
  private grants = new Map<string, Grant>();
  issue(token: string, tenant: string, scopes: string[]) { this.grants.set(token, { tenant, scopes: new Set(scopes), revoked: false }); }
  revoke(token: string) { const g = this.grants.get(token); if (g) g.revoked = true; }
  check(token: string, tenant: string, scope: string): string | null {
    const g = this.grants.get(token);
    if (!g) return "unknown token";
    if (g.revoked) return "token revoked";
    if (g.tenant !== tenant) return "token belongs to another tenant";
    if (!g.scopes.has(scope)) return `token lacks ${scope}`;
    return null;
  }
}

export class FakeErp {
  entries: Entry[] = [];
  private creds: Credentials;
  private fault: (e: Entry) => Fault;
  constructor(creds: Credentials, fault: (e: Entry) => Fault = () => "ok") { this.creds = creds; this.fault = fault; }

  post(token: string, e: Entry): { id: number } {
    const denied = this.creds.check(token, e.tenant, "ledger:write");
    if (denied) throw new ForbiddenError(denied);
    const f = this.fault(e);
    if (f === "fail-before-write") throw new TransientError("503 service unavailable");
    this.entries.push({ ...e });
    if (f === "timeout-after-write") throw new TimeoutError("timed out waiting for response");
    return { id: this.entries.length };
  }

  findByReference(token: string, tenant: string, reference: string): Entry | undefined {
    const denied = this.creds.check(token, tenant, "ledger:read");
    if (denied) throw new ForbiddenError(denied);
    return this.entries.find((e) => e.tenant === tenant && e.reference === reference);
  }

  writesFor(reference: string): number { return this.entries.filter((e) => e.reference === reference).length; }
}
