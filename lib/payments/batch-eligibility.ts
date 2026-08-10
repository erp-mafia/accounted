/**
 * Eligibility rules for including a supplier invoice in a payment batch.
 *
 * Single source of truth used by BOTH the preview route and the create route:
 * create re-evaluates every invoice against the same rules, so a row that
 * changed between preview and create (paid meanwhile, due date moved, supplier
 * details edited) is rejected instead of silently paid on stale terms.
 *
 * Warnings never block; exclusions always do. An un-attested invoice is a
 * warning (mark-paid pays registered invoices today, and sjalvbokforare have
 * no attest step), while a missing payee is an exclusion (there is nothing to
 * route the payment to).
 */

import { ORE_TOLERANCE, roundOre } from '@/lib/money'
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
  supplier_invoice_number: string
}

export interface BatchEvaluationOptions {
  /** ISO yyyy-MM-dd. Passed in so preview and create agree within a request. */
  today: string
  /** invoice id -> active (created, not cancelled) batch id it already sits in. */
  activeBatchIdByInvoice?: ReadonlyMap<string, string>
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
  if (invoice.currency !== 'SEK') return { eligible: false, reason: 'foreign_currency' }

  const resolution = resolveSupplierPayee(supplier)
  if (!resolution.ok) return { eligible: false, reason: resolution.reason }

  const { reference, ocrInvalid } = resolvePaymentReference(invoice)

  const warnings: BatchItemWarning[] = []
  if (!invoice.approved_at) warnings.push('unattested')
  const activeBatchId = options.activeBatchIdByInvoice?.get(invoice.id) ?? null
  if (activeBatchId) warnings.push('already_batched')
  if (ocrInvalid) warnings.push('ocr_invalid')
  if (!supplier.city?.trim()) warnings.push('payee_city_missing')

  return {
    eligible: true,
    defaults: {
      amount: roundOre(invoice.remaining_amount),
      // A due date in the future is honored; a passed one pays as soon as the
      // bank can execute.
      payment_date: invoice.due_date > options.today ? invoice.due_date : options.today,
    },
    payee: resolution.payee,
    reference,
    warnings,
    activeBatchId,
  }
}
