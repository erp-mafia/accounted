/**
 * Eligibility rules for including a supplier invoice in a payment batch.
 *
 * Single source of truth used by BOTH the preview route and the create route:
 * create re-evaluates every invoice against the same rules, so a row that
 * changed between preview and create (paid meanwhile, due date moved, supplier
 * details edited) is rejected instead of silently paid on stale terms.
 *
 * Warnings never block; exclusions always do. An un-attested invoice is a
 * warning (mark-paid pays registered invoices today), while a missing payee
 * is an exclusion (there is nothing to route the payment to). The warning is
 * only for a company that attests at all: kontantmetoden has no attest step,
 * so there it would sit on every line and mean nothing (crm#1141); the caller
 * reads that through the attest gate (attest-gate.ts). With the company's
 * attest policy on, an invoice the policy requires attest for and has not got
 * it is an exclusion instead (attest_required), read through the same gate.
 */

import { ORE_TOLERANCE, roundOre } from '@/lib/money'
import { bankDayOnOrBeforeIso } from './bank-days'
import type { PayeeHold } from './payee-change'
import {
  resolvePaymentReference,
  resolveSupplierPayee,
  type PaymentReference,
  type SupplierPayee,
  type SupplierPayeeSource,
} from './supplier-payee'

/**
 * Statuses a payment instruction may be created for: exactly the set the
 * mark-paid route accepts, so the batch can never contain an invoice the
 * settlement path would refuse.
 */
export const PAYABLE_SUPPLIER_INVOICE_STATUSES = [
  'registered',
  'approved',
  'partially_paid',
  'overdue',
] as const


export type BatchExclusionReason =
  | 'not_payable'
  | 'nothing_remaining'
  | 'credit_note'
  | 'foreign_currency'
  | 'payee_missing'
  | 'payee_invalid'
  // No valid OCR and no supplier invoice number: the payment would reach the
  // supplier with nothing to match it by (resolvePaymentReference).
  | 'reference_missing'
  // The attest policy requires attest for the invoice and it has not been given.
  | 'attest_required'
  // The supplier debits the invoice itself (autogiro, account debit): paying
  // it as well would pay it twice (crm#1463).
  | 'auto_debit'
  // The invoice states an account the company does not have for the supplier
  // and nobody has confirmed it (lib/payments/payee-alerts.ts), or a person
  // rejected it: no payment until a person decides.
  | PayeeHold

export type BatchItemWarning =
  | 'unattested'
  | 'already_batched'
  | 'ocr_invalid'
  // Swedbank rejects a creditor address without a town (Validex rules
  // 237 + 222), and the address itself is mandatory; warn so the user fills
  // in the supplier's city before the bank bounces the file.
  | 'payee_city_missing'

export interface BatchInvoiceFacts {
  id: string
  status: string
  approved_at: string | null
  due_date: string
  remaining_amount: number
  currency: string
  is_credit_note: boolean
  payment_reference: string | null
  supplier_invoice_number: string | null
  /** Paid by the supplier's own debit (autogiro, account debit); absent reads as false. */
  auto_debit?: boolean
  /**
   * What holds a payment of the invoice back until a person decides on the
   * account it states (loadPayeeHolds); absent or null when nothing does.
   */
  payee_hold?: PayeeHold | null
}

export interface BatchEvaluationOptions {
  /** ISO yyyy-MM-dd. Passed in so preview and create agree within a request. */
  today: string
  /** invoice id -> active (created, not cancelled) batch id it already sits in. */
  activeBatchIdByInvoice?: ReadonlyMap<string, string>
  /** Invoices payment waits with: the attest policy requires attest and it has not been given. */
  attestBlocked?: ReadonlySet<string>
  /**
   * Whether the company attests supplier invoices at all
   * (PAYMENT_ATTEST_GATE.attestsSupplierInvoices). False (no attest step:
   * kontantmetoden, or no attest policy on): an invoice without approved_at
   * is not 'unattested'. Absent reads as true, as
   * a company without a setting reads as faktureringsmetoden.
   */
  companyAttests?: boolean
}

export type BatchInvoiceEvaluation =
  | {
      eligible: true
      defaults: { amount: number; payment_date: string }
      payee: SupplierPayee
      reference: PaymentReference
      warnings: BatchItemWarning[]
      activeBatchId: string | null
    }
  | { eligible: false; reason: BatchExclusionReason }

/**
 * The day a supplier invoice is paid unless someone picks another: its due
 * date, or the last banking day before it when it falls on a weekend or
 * holiday. A bank pays a non-banking day on the next banking day, which is
 * after the due date (crm#1595). A due date that has passed, or whose banking
 * day has, pays as soon as the bank can execute: today.
 */
export function defaultPaymentDate(dueDate: string, today: string): string {
  const onOrBefore = bankDayOnOrBeforeIso(dueDate)
  return onOrBefore > today ? onOrBefore : today
}

export function evaluateInvoiceForBatch(
  invoice: BatchInvoiceFacts,
  supplier: SupplierPayeeSource & { city?: string | null },
  options: BatchEvaluationOptions,
): BatchInvoiceEvaluation {
  if (invoice.is_credit_note) return { eligible: false, reason: 'credit_note' }
  if (!(PAYABLE_SUPPLIER_INVOICE_STATUSES as readonly string[]).includes(invoice.status)) {
    return { eligible: false, reason: 'not_payable' }
  }
  if (invoice.remaining_amount <= ORE_TOLERANCE) {
    return { eligible: false, reason: 'nothing_remaining' }
  }
  if (invoice.auto_debit) return { eligible: false, reason: 'auto_debit' }
  if (invoice.currency !== 'SEK') return { eligible: false, reason: 'foreign_currency' }
  // Before the payee: the card may be the old account or empty, and the
  // reason a person must act on is the account the invoice states.
  if (invoice.payee_hold) return { eligible: false, reason: invoice.payee_hold }
  if (options.attestBlocked?.has(invoice.id)) return { eligible: false, reason: 'attest_required' }

  const resolution = resolveSupplierPayee(supplier)
  if (!resolution.ok) return { eligible: false, reason: resolution.reason }

  const { reference, ocrInvalid } = resolvePaymentReference(invoice)
  if (!reference) return { eligible: false, reason: 'reference_missing' }

  const warnings: BatchItemWarning[] = []
  if (options.companyAttests !== false && !invoice.approved_at) warnings.push('unattested')
  const activeBatchId = options.activeBatchIdByInvoice?.get(invoice.id) ?? null
  if (activeBatchId) warnings.push('already_batched')
  if (ocrInvalid) warnings.push('ocr_invalid')
  if (!supplier.city?.trim()) warnings.push('payee_city_missing')

  return {
    eligible: true,
    defaults: {
      amount: roundOre(invoice.remaining_amount),
      payment_date: defaultPaymentDate(invoice.due_date, options.today),
    },
    payee: resolution.payee,
    reference,
    warnings,
    activeBatchId,
  }
}
