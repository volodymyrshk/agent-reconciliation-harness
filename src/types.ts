// Domain types. Amounts are always integer minor units (cents) plus an ISO currency code.

export type Money = { minor: number; currency: string };

export type Invoice = {
  tenant: string;
  id: string;            // e.g. "INV-1042"
  customer: string;      // canonical customer id in the ERP
  amount: Money;
  status: "open" | "paid";
};

// A payment event as it arrives from the payment provider. Nothing here is trusted:
// the customer reference is free text from the CRM / bank, the memo is whatever the payer typed.
export type Payment = {
  tenant: string;
  id: string;            // provider event id; the same id can be delivered more than once
  customerRef: string;
  amount: Money;
  memo: string;
};

// Everything one decision may look at, scoped to a single tenant.
export type CaseInput = {
  payment: Payment;
  invoices: Invoice[];                 // this tenant's invoices only
  aliases: Record<string, string>;     // CRM name -> ERP customer id, this tenant only
  seenPaymentIds: string[];            // provider ids this tenant already applied
};

export type Decision =
  | { kind: "apply"; invoiceId: string; adjustmentMinor: number }
  | { kind: "duplicate" }
  | { kind: "unapplied" }
  | { kind: "review"; reason: string };

export type Source = "rule" | "model" | "human";

export type Proposal = {
  decision: Decision;
  confidence: number;    // 0..1
  source: Source;
  rule?: string;         // which deterministic rule fired
  rationale?: string;    // model or reviewer explanation
};
