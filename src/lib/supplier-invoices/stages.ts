/**
 * Supplier-invoice lifecycle stages (UI v2 PR 6).
 *
 * Product decision 2026-09-07: Inköp shows the invoice as a flow, Inkommen →
 * Registrerad → Attesterad → I betalfil → Betald → Avstämd. The stage is
 * DERIVED from what already exists (status, approved_at, an open payment
 * batch, the paying bank row and the account's sign-off) instead of adding
 * states to SupplierInvoiceStatus: every consumer of the status enum keeps
 * working, and when payment initiation replaces the bank file the "in file"
 * step swaps its evidence, not its place.
 */

import { todayIsoStockholm } from '@/lib/dates/iso'
import { paymentOrderWaitsFor } from '@/lib/payments/orders/status'
import { companyAttestsSupplierInvoices, isOverduePayable } from './lifecycle'
import { isSupplierInvoiceAttested } from './reported-status'

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
  /**
   * The company's method, which picks its ladder (stagesFor): kontantmetoden
   * has no attest step. Omitted reads as faktureringsmetoden.
   */
  accounting_method?: string | null
}

/** The invoice's step, always one on the company's own ladder (stagesFor). */
export function deriveStage(i: StageInput): SupplierInvoiceStage {
  if (i.is_credit_note || i.status === 'credited' || i.status === 'reversed') return 'credited'
  if (i.status === 'paid') return i.reconciled ? 'reconciled' : 'paid'
  if (i.in_open_batch) return 'in_file'
  // An attest on a kontantmetod company's invoice (given before a switch of
  // method, or through the API) has no step on its ladder: the invoice is
  // still registered and waiting for its payment (#93).
  if (isSupplierInvoiceAttested(i) && companyAttestsSupplierInvoices(i.accounting_method)) return 'approved'
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
 * is open and has gone to the bank (sent, signed, or executed and not yet
 * matched), so every payment channel refuses the invoice and it is not
 * waiting for a payment. 'bank_payment_unsigned': a bank payment order is
 * open and waits for a person, prepared and not approved or approved and not
 * signed (paymentOrderWaitsFor): every payment channel refuses the invoice
 * all the same, but nothing is at the bank and nothing is paid until someone
 * signs on Betalningar (crm#1925: it read as I betalning, as if nothing more
 * was needed). 'bank_entered': a person ticked "Inlagd i banken" (the payment
 * was typed into the internet bank by hand) and the invoice has not fallen
 * due (bankEnteredHolds, crm#1824). 'payment_file': it sits in a payment file
 * that was generated, which may or may not have reached the bank. Null when
 * nothing covers it or it is settled.
 */
export type OpenPaymentMarker = 'bank_payment' | 'bank_payment_unsigned' | 'bank_entered' | 'payment_file'

/**
 * True when an open bank payment order covers the invoice, at the bank or
 * still waiting for its signature: no new payment of the invoice is offered
 * while one stands (the server refuses it in every channel anyway).
 */
export function hasOpenBankPaymentOrder(marker: OpenPaymentMarker | null): boolean {
  return marker === 'bank_payment' || marker === 'bank_payment_unsigned'
}

/** Nothing left to pay on these: no payment instruction is relevant to them. */
export const SETTLED_SUPPLIER_INVOICE_STATUSES: ReadonlySet<string> = new Set(['paid', 'credited', 'reversed'])

/** What the "Inlagd i banken" rule reads off an invoice. */
export interface BankEnteredFacts {
  status: string
  is_credit_note?: boolean | null
  /** When a person ticked "Inlagd i banken"; null or absent when not ticked. */
  bank_entered_at?: string | null
  due_date?: string | null
  remaining_amount?: number | null
}

/**
 * True while the "Inlagd i banken" tick stands for a payment under way: the
 * tick is set and the invoice has not fallen due (crm#1824). The tick is a
 * person's word, not a payment the system follows, so it holds only until the
 * due date has passed: an invoice still unpaid after it is back among what
 * waits to be paid, where a tick nobody followed up cannot hide it. Fallen
 * due is the list's own rule: the stored 'overdue' status, or the predicate
 * the nightly flip runs (isOverduePayable), which also covers a part-paid
 * invoice and the hours before the flip. `today` is todayIsoStockholm().
 * One definition for the list tabs (openPaymentMarker) and the to-pay counts
 * (lib/supplier-invoices/attest-queues.ts).
 */
export function bankEnteredHolds(invoice: BankEnteredFacts, today: string): boolean {
  if (!invoice.bank_entered_at) return false
  if (invoice.is_credit_note || SETTLED_SUPPLIER_INVOICE_STATUSES.has(invoice.status)) return false
  if (invoice.status === 'overdue') return false
  if (!invoice.due_date) return true
  return !isOverduePayable(
    {
      due_date: invoice.due_date,
      // A caller that did not read the amount asks about an unsettled invoice: something is left.
      remaining_amount: invoice.remaining_amount ?? Number.POSITIVE_INFINITY,
      is_credit_note: invoice.is_credit_note,
    },
    today,
  )
}

/**
 * The marker of an invoice, the strongest evidence first: a bank payment
 * order the system follows (one that still waits for a person reads as
 * unsigned), then a standing "Inlagd i banken" tick, then a payment file. A
 * tick beside a file reads as the tick: the person says the payment is at the
 * bank, which is the one thing a file cannot tell.
 */
export function openPaymentMarker(
  invoice: BankEnteredFacts & { open_payment?: OpenPaymentInstruction | null },
  today: string = todayIsoStockholm(),
): OpenPaymentMarker | null {
  if (invoice.is_credit_note || SETTLED_SUPPLIER_INVOICE_STATUSES.has(invoice.status)) return null
  const order = invoice.open_payment?.payment_order
  if (order) return paymentOrderWaitsFor(order) ? 'bank_payment_unsigned' : 'bank_payment'
  if (bankEnteredHolds(invoice, today)) return 'bank_entered'
  if (invoice.open_payment?.batch) return 'payment_file'
  return null
}

/**
 * The chip label per marker, in the `supplier_invoices` namespace: a bank
 * payment reads as the ladder's own step, one nobody has signed as waiting
 * for its signature, a tick as the tick's own label.
 */
export const OPEN_PAYMENT_MARKER_LABEL_KEYS: Record<OpenPaymentMarker, string> = {
  bank_payment: 'stage_in_file',
  bank_payment_unsigned: 'bank_payment_unsigned_chip',
  bank_entered: 'bank_entered_label',
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
