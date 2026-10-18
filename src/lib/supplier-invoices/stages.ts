/**
 * Supplier-invoice lifecycle stages (UI v2 PR 6).
 *
 * Founder decision 2026-09-07: Inköp shows the invoice as a flow, Inkommen →
 * Registrerad → Attesterad → I betalfil → Betald → Avstämd. The stage is
 * DERIVED from what already exists (status, approved_at, an open payment
 * batch, the paying bank row and the account's sign-off) instead of adding
 * states to SupplierInvoiceStatus: every consumer of the status enum keeps
 * working, and when payment initiation replaces the bank file the "in file"
 * step swaps its evidence, not its place.
 */

import { companyAttestsSupplierInvoices } from './lifecycle'

export const SUPPLIER_INVOICE_STAGES = [
  'incoming',
  'registered',
  'approved',
  'in_file',
  'paid',
  'reconciled',
] as const

export type SupplierInvoiceLadderStage = (typeof SUPPLIER_INVOICE_STAGES)[number]

/** Credited and reversed invoices leave the ladder. */
export type SupplierInvoiceStage = SupplierInvoiceLadderStage | 'credited'

/** Steps the system takes without the user. */
export const AUTO_STAGES: ReadonlySet<SupplierInvoiceLadderStage> = new Set(['incoming', 'paid', 'reconciled'])

export interface StageInput {
  status: string
  approved_at: string | null
  is_credit_note: boolean
  /**
   * Covered by a payment instruction that is still open: a payment file batch
   * that is neither cancelled nor settled, or a bank payment order that has
   * not failed, been rejected or cancelled, and whose debit is not yet matched
   * (isOpenPaymentOrder). Same step on the ladder, two kinds of evidence.
   */
  in_open_batch: boolean
  /** Every paying bank row is signed off in a reconciliation through its date. */
  reconciled: boolean
}

export function deriveStage(i: StageInput): SupplierInvoiceStage {
  if (i.is_credit_note || i.status === 'credited' || i.status === 'reversed') return 'credited'
  if (i.status === 'paid') return i.reconciled ? 'reconciled' : 'paid'
  if (i.in_open_batch) return 'in_file'
  if (i.approved_at || i.status === 'approved') return 'approved'
  // registered, overdue, partially_paid, disputed: still a debt awaiting attest.
  return 'registered'
}

/** 0-based position on the ladder; -1 for invoices that left it. */
export function stageIndex(stage: SupplierInvoiceStage): number {
  return stage === 'credited' ? -1 : SUPPLIER_INVOICE_STAGES.indexOf(stage)
}

/**
 * Ladder for a company. Kontantmetod companies do not attest (the debt is
 * never booked before payment), so their ladder skips Attesterad.
 */
export function stagesFor(accountingMethod: 'accrual' | 'cash' | null | undefined): readonly SupplierInvoiceLadderStage[] {
  return companyAttestsSupplierInvoices(accountingMethod)
    ? SUPPLIER_INVOICE_STAGES
    : SUPPLIER_INVOICE_STAGES.filter((s) => s !== 'approved')
}

/**
 * The open payment instructions covering an invoice: the evidence for the
 * in_file step (lifecycle-stages.ts, loadOpenPaymentInstructions). At most one
 * of the two is set in practice: the database refuses a file item for an
 * invoice with an open order, and an order for an invoice in an open file.
 */
export interface OpenPaymentInstruction {
  /** The open payment batch carrying the invoice, if any. */
  batch: { id: string; created_at: string } | null
  /**
   * The open bank payment order carrying the invoice, if any, with what the
   * bank last said about it (provider_status, e.g. RCVD for a payment at the
   * bank that nobody has signed) and the code of a failure that holds it
   * (provider_error_code), so a reader outside the app (the agent, the API)
   * sees what the app shows.
   */
  payment_order: {
    id: string
    status: string
    created_at: string
    provider_status: string | null
    provider_error_code: string | null
  } | null
}

/**
 * What a person deciding what to pay is told about an unsettled invoice that
 * a payment instruction already covers. 'bank_payment': a bank payment order
 * is open (prepared, sent, signed, or executed and not yet matched), so every
 * payment channel refuses the invoice and it is not waiting for a payment.
 * 'payment_file': it sits in a payment file that was generated, which may or
 * may not have reached the bank. Null when nothing covers it or it is settled.
 */
export type OpenPaymentMarker = 'bank_payment' | 'payment_file'

/** Nothing left to pay on these: no payment instruction is relevant to them. */
export const SETTLED_SUPPLIER_INVOICE_STATUSES: ReadonlySet<string> = new Set(['paid', 'credited', 'reversed'])

export function openPaymentMarker(invoice: {
  status: string
  is_credit_note?: boolean | null
  open_payment?: OpenPaymentInstruction | null
}): OpenPaymentMarker | null {
  if (invoice.is_credit_note || SETTLED_SUPPLIER_INVOICE_STATUSES.has(invoice.status)) return null
  if (invoice.open_payment?.payment_order) return 'bank_payment'
  if (invoice.open_payment?.batch) return 'payment_file'
  return null
}

/** The chip label per marker, in the `supplier_invoices` namespace: a bank payment reads as the ladder's own step. */
export const OPEN_PAYMENT_MARKER_LABEL_KEYS: Record<OpenPaymentMarker, string> = {
  bank_payment: 'stage_in_file',
  payment_file: 'in_batch_chip',
}

export interface InvoiceLifecycle extends OpenPaymentInstruction {
  stage: SupplierInvoiceStage
  approved_at: string | null
  /** The bank row that paid it, if matched. */
  paid: { transaction_id: string; date: string } | null
  /** Sign-off date that covers the payment, when reconciled. */
  reconciled_through: string | null
}

export function countByStage(
  lifecycles: Iterable<InvoiceLifecycle>,
): Record<SupplierInvoiceStage, number> {
  const counts = {
    incoming: 0,
    registered: 0,
    approved: 0,
    in_file: 0,
    paid: 0,
    reconciled: 0,
    credited: 0,
  } satisfies Record<SupplierInvoiceStage, number>
  for (const l of lifecycles) counts[l.stage] += 1
  return counts
}
