/**
 * Kvittning, planned: whether a customer invoice and a supplier invoice may be
 * set off against each other, for how much, and what each is left with.
 *
 * Pure and client-safe: the set-off dialog previews with it, the service
 * refuses with it before calling the database, and book_counterparty_setoff
 * (migration 20261022130100) checks the same rules again under its row locks,
 * in the same order, answering the same codes.
 */
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { roundOre } from '@/lib/money'
import type { SetoffErrorCode } from './errors'

/** A customer invoice as the set-off reads it. */
export interface SetoffInvoiceFacts {
  id: string
  /** The number shown everywhere (invoiceDisplayNumber). */
  number: string | null
  status: string
  documentType: string | null
  creditedInvoiceId: string | null
  currency: string | null
  total: number
  /** What the customer still owes, in the invoice currency. */
  remaining: number
  paid: number
  deductionTotal: number
  invoiceDate: string
  dueDate: string | null
  /** The invoice's own voucher is on the ledger (a fordran on 151x). */
  booked: boolean
  /** The canonical party of the invoice's customer; null when it has none. */
  partyId: string | null
  /** An open collection case: the provider holds the claim. */
  collectionOpen: boolean
}

/** A supplier invoice as the set-off reads it. */
export interface SetoffSupplierInvoiceFacts {
  id: string
  /** The supplier's printed number, or null. */
  number: string | null
  arrivalNumber: number | null
  status: string
  isCreditNote: boolean
  currency: string | null
  total: number
  /** What the company still owes, in the invoice currency. */
  remaining: number
  paid: number
  invoiceDate: string
  dueDate: string | null
  /** The registration voucher is on the ledger (a skuld on 244x). */
  booked: boolean
  partyId: string | null
  /** Entered at the bank, in a payment file or in an open payment order. */
  paymentInFlight: boolean
}

export type SetoffIneligibleReason =
  | 'credit_note'
  | 'not_open'
  | 'currency'
  | 'deduction'
  | 'not_booked'
  | 'no_party'
  | 'collection_open'
  | 'payment_in_flight'

const OPEN_INVOICE_STATUSES: ReadonlySet<string> = new Set(['sent', 'overdue', 'partially_paid'])
const OPEN_SUPPLIER_INVOICE_STATUSES: ReadonlySet<string> = new Set(['registered', 'approved', 'overdue', 'partially_paid'])

/** Why a customer invoice cannot be set off, or null when it can. */
export function customerInvoiceIneligibility(invoice: SetoffInvoiceFacts): SetoffIneligibleReason | null {
  if ((invoice.documentType ?? 'invoice') !== 'invoice' || invoice.creditedInvoiceId) return 'credit_note'
  if (!OPEN_INVOICE_STATUSES.has(invoice.status) || !(invoice.remaining > 0)) return 'not_open'
  if (!isLedgerCurrency(invoice.currency)) return 'currency'
  if (invoice.deductionTotal > 0) return 'deduction'
  if (!invoice.booked) return 'not_booked'
  if (!invoice.partyId) return 'no_party'
  if (invoice.collectionOpen) return 'collection_open'
  return null
}

/** Why a supplier invoice cannot be set off, or null when it can. */
export function supplierInvoiceIneligibility(invoice: SetoffSupplierInvoiceFacts): SetoffIneligibleReason | null {
  if (invoice.isCreditNote) return 'credit_note'
  if (!OPEN_SUPPLIER_INVOICE_STATUSES.has(invoice.status) || !(invoice.remaining > 0)) return 'not_open'
  if (!isLedgerCurrency(invoice.currency)) return 'currency'
  if (!invoice.booked) return 'not_booked'
  if (!invoice.partyId) return 'no_party'
  if (invoice.paymentInFlight) return 'payment_in_flight'
  return null
}

const CUSTOMER_REASON_CODE: Readonly<Record<SetoffIneligibleReason, SetoffErrorCode>> = {
  credit_note: 'SETOFF_INVOICE_NOT_ELIGIBLE',
  not_open: 'SETOFF_INVOICE_NOT_OPEN',
  currency: 'SETOFF_CURRENCY_UNSUPPORTED',
  deduction: 'SETOFF_DEDUCTION_UNSUPPORTED',
  not_booked: 'SETOFF_INVOICE_NOT_BOOKED',
  no_party: 'SETOFF_NO_PARTY',
  collection_open: 'SETOFF_COLLECTION_OPEN',
  payment_in_flight: 'SETOFF_PAYMENT_IN_FLIGHT',
}

const SUPPLIER_REASON_CODE: Readonly<Record<SetoffIneligibleReason, SetoffErrorCode>> = {
  ...CUSTOMER_REASON_CODE,
  credit_note: 'SETOFF_SUPPLIER_INVOICE_NOT_ELIGIBLE',
  not_open: 'SETOFF_SUPPLIER_INVOICE_NOT_OPEN',
}

/** The amount a set-off of the two takes when none is given: the smaller remaining amount. */
export function setoffDefaultAmount(invoice: Pick<SetoffInvoiceFacts, 'remaining'>, supplierInvoice: Pick<SetoffSupplierInvoiceFacts, 'remaining'>): number {
  return roundOre(Math.max(0, Math.min(invoice.remaining, supplierInvoice.remaining)))
}

/** The status an invoice settles to once `remaining` is left. */
function statusAfter(remaining: number): 'paid' | 'partially_paid' {
  return remaining <= 0 ? 'paid' : 'partially_paid'
}

export interface SetoffPlan {
  amount: number
  setoffDate: string
  partyId: string
  invoice: { id: string; number: string | null; remainingBefore: number; remainingAfter: number; statusAfter: 'paid' | 'partially_paid' }
  supplierInvoice: {
    id: string
    number: string | null
    arrivalNumber: number | null
    remainingBefore: number
    remainingAfter: number
    statusAfter: 'paid' | 'partially_paid'
  }
  /**
   * What is left between the two once they are set off: `we_pay` when the
   * supplier invoice still has more open, `they_pay` when the customer
   * invoice does, `settled` when nothing is left.
   */
  net: { direction: 'we_pay' | 'they_pay' | 'settled'; amount: number }
}

export type SetoffPlanResult =
  | { ok: true; plan: SetoffPlan }
  | { ok: false; code: SetoffErrorCode; details?: Record<string, unknown> }

/**
 * Plan a set-off of `invoice` against `supplierInvoice` for `amount` (the
 * smaller remaining amount when omitted) on `setoffDate`. `today` is the
 * Stockholm date: a set-off is never dated in the future.
 */
export function planSetoff(input: {
  invoice: SetoffInvoiceFacts
  supplierInvoice: SetoffSupplierInvoiceFacts
  amount?: number | null
  setoffDate: string
  today: string
}): SetoffPlanResult {
  const { invoice, supplierInvoice, setoffDate, today } = input

  const customerReason = customerInvoiceIneligibility(invoice)
  if (customerReason) {
    return { ok: false, code: CUSTOMER_REASON_CODE[customerReason], details: { side: 'customer', invoice_id: invoice.id, reason: customerReason } }
  }
  const supplierReason = supplierInvoiceIneligibility(supplierInvoice)
  if (supplierReason) {
    return {
      ok: false,
      code: SUPPLIER_REASON_CODE[supplierReason],
      details: { side: 'supplier', supplier_invoice_id: supplierInvoice.id, reason: supplierReason },
    }
  }
  if (invoice.partyId !== supplierInvoice.partyId) return { ok: false, code: 'SETOFF_PARTY_MISMATCH' }

  const invoiceRemaining = roundOre(invoice.remaining)
  const supplierRemaining = roundOre(supplierInvoice.remaining)
  const amount = input.amount == null ? setoffDefaultAmount(invoice, supplierInvoice) : input.amount
  if (!Number.isFinite(amount) || amount <= 0 || roundOre(amount) !== amount) {
    return { ok: false, code: 'SETOFF_INVALID_AMOUNT', details: { amount } }
  }
  if (amount > invoiceRemaining || amount > supplierRemaining) {
    return {
      ok: false,
      code: 'SETOFF_AMOUNT_EXCEEDS_REMAINING',
      details: { amount, invoice_remaining: invoiceRemaining, supplier_invoice_remaining: supplierRemaining },
    }
  }

  if (setoffDate > today) return { ok: false, code: 'SETOFF_DATE_INVALID', details: { reason: 'future', setoff_date: setoffDate } }
  if (setoffDate < invoice.invoiceDate || setoffDate < supplierInvoice.invoiceDate) {
    return { ok: false, code: 'SETOFF_DATE_INVALID', details: { reason: 'before_invoice', setoff_date: setoffDate } }
  }

  const invoiceAfter = roundOre(invoiceRemaining - amount)
  const supplierAfter = roundOre(supplierRemaining - amount)
  const netValue = roundOre(invoiceAfter - supplierAfter)
  return {
    ok: true,
    plan: {
      amount,
      setoffDate,
      partyId: invoice.partyId as string,
      invoice: {
        id: invoice.id,
        number: invoice.number,
        remainingBefore: invoiceRemaining,
        remainingAfter: invoiceAfter,
        statusAfter: statusAfter(invoiceAfter),
      },
      supplierInvoice: {
        id: supplierInvoice.id,
        number: supplierInvoice.number,
        arrivalNumber: supplierInvoice.arrivalNumber,
        remainingBefore: supplierRemaining,
        remainingAfter: supplierAfter,
        statusAfter: statusAfter(supplierAfter),
      },
      net: {
        direction: netValue > 0 ? 'they_pay' : netValue < 0 ? 'we_pay' : 'settled',
        amount: Math.abs(netValue),
      },
    },
  }
}
