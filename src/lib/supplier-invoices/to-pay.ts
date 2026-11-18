/**
 * Which supplier invoices wait to be paid: one answer for the Att betala tab
 * and its count, the Att göra row "Betala N leverantörsfakturor" and
 * status=to_pay in GET /api/supplier-invoices and MCP
 * gnubok_list_supplier_invoices.
 *
 * Each kept its own reading: the tab counted every payable status, attested
 * or not; the Att göra row only attested invoices of a company without an
 * attest policy, and only the policy's own invoices of a company with one;
 * the API and MCP the statuses "Markera som betald" is offered for, an
 * invoice already at the bank or with nothing left included. Att göra said
 * "Betala 1" and the tab it opens showed 3.
 *
 * An invoice waits to be paid when the payment file would pay it and nobody
 * has started to: a payable status (PAYABLE_SUPPLIER_INVOICE_STATUSES), money
 * left, not a credit note, not debited by the supplier itself (crm#1463), not
 * at the bank (an open bank payment, crm#1243, or the "Inlagd i banken" tick
 * while it holds, crm#1824), and not held by the attest policy
 * (paymentWaitsForAttest, the payment file's own attest_required). Without a
 * policy attest is not a step before payment: the payment file pays an
 * unattested invoice with a warning, and most such companies never attest
 * (2026-11-12: 229 of 386). A payment file keeps the invoice waiting: a
 * generated file may never have reached the bank.
 *
 * Pure and dependency-light: the list page imports it.
 */
import { PAYABLE_SUPPLIER_INVOICE_STATUSES } from '@/lib/payments/batch-eligibility'
import { FULLY_PAID_EPSILON } from './lifecycle'

export interface ToPayFacts {
  status: string
  is_credit_note?: boolean | null
  /** A missing value counts as money left: the caller did not read it. */
  remaining_amount?: number | null
  auto_debit?: boolean | null
}

export interface ToPayState {
  /** An open bank payment covers it, or the "Inlagd i banken" tick still holds (bankEnteredHolds). */
  atTheBank: boolean
  /** The attest policy requires attest for it and it has not been given (paymentWaitsForAttest). */
  waitsForAttest: boolean
}

const PAYABLE: ReadonlySet<string> = new Set(PAYABLE_SUPPLIER_INVOICE_STATUSES)

/** True when the invoice waits for someone to pay it (see the file header). */
export function waitsToBePaid(invoice: ToPayFacts, state: ToPayState): boolean {
  if (invoice.is_credit_note) return false
  if (!PAYABLE.has(invoice.status)) return false
  if (typeof invoice.remaining_amount === 'number' && invoice.remaining_amount <= FULLY_PAID_EPSILON) return false
  if (invoice.auto_debit) return false
  return !state.atTheBank && !state.waitsForAttest
}
