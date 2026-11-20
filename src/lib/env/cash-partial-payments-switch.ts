/**
 * CASH_PARTIAL_PAYMENTS_ENABLED: kontantmetoden part payments of a
 * never-booked customer invoice, booked pro rata per installment
 * (settleInvoicePayment with buildInvoiceCashPartialLines). Unset = off
 * (accountant sign-off, build spec 4.5 item 2).
 *
 * Off means exactly the behaviour before the rule existed: every payment door
 * refuses such a part payment, and the completion of an earlier one, with
 * INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED, and the whole-payment cash entry
 * books as before. Read on every call, like the collections flags.
 *
 * Kept in the shared lib/env rather than lib/invoices: the ledger's
 * systemdokumentation reads the switch too, and the ledger imports nothing
 * from the invoicing block (Phase 2's exit check,
 * lib/modules/__tests__/phase2-exit-check.test.ts).
 */
export function cashPartialPaymentsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.CASH_PARTIAL_PAYMENTS_ENABLED?.trim().toLowerCase()
  return v === '1' || v === 'true'
}
