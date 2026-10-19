/**
 * The focus view's one question: for the item in focus, the question to ask,
 * the one line of evidence under it, and at most three answers.
 *
 * Every answer is an action the Underlag workspace already offers, on the
 * endpoint it already calls; this decides only which of them fit the item:
 *   - register_invoice: NewSupplierInvoiceDialog (POST /items/:id/convert);
 *   - match_purchase: TransactionMatchPicker (POST /items/:id/match-transaction);
 *   - accept_bank_match: the same match-transaction, with the bank row the
 *     Inkorg found when the document arrived (bank_match) instead of a pick;
 *   - register_and_settle: NewSupplierInvoiceDialog with that bank row fixed,
 *     which registers the invoice and books its payment against the row in
 *     one request (POST /api/inkorg/items/:id/register-and-settle);
 *   - pay_in_bank: NewSupplierInvoiceDialog, then what to type in the bank
 *     (giro, OCR or message, amount, due date) read off the registered invoice;
 *   - expense: RegisterExpenseDialog (the utlägg);
 *   - book: EditKonteringDialog with the proposal (POST /items/:id/suggest-booking);
 *   - unmatch: POST /items/:id/unmatch-transaction;
 *   - not_underlag: DELETE /items/:id (the document stays in the archive);
 *   - retry_reading: POST /items/:id/retry-extraction;
 *   - credit: InboxCreditNotePanel (POST /api/supplier-invoices/:id/credit);
 *   - open_entry, open_supplier_invoice, open_matched_entry: links.
 *
 * What the company has switched off decides too (lib/modules/package-doors.ts:
 * an off or winding-down package refuses its start doors), so no answer is
 * offered that the server would refuse:
 *   - pay_in_bank_unregistered: without Leverantörsfakturor, what to type in
 *     the bank read off the document itself; nothing is registered, and the
 *     payment is booked with the document when it reaches the bank
 *     (kontantmetoden);
 *   - wait_for_payment: "not paid yet" without Leverantörsfakturor under
 *     kontantmetoden: nothing is written, the bank check offers the row once
 *     it arrives;
 *   - owner_paid: without Utlägg, an enskild firma's cost paid with the
 *     owner's own money, booked through book-direct against 2018 Egna
 *     insättningar (no utlägg to settle: the money is the owner's);
 *   - turn_on_supplier_invoices, turn_on_expenses: Anpassa, where the package
 *     is switched on, when the answer needs it (faktureringsmetoden books an
 *     unpaid invoice as a debt when it arrives; an aktiebolag's utlägg is a
 *     debt to the person who paid).
 * Without a `startable` context every package counts as on, which is every
 * company without a stored profile or a package switch.
 *
 * An invoice that came with its receipt as one purchase (./pairs.ts) is
 * paid: the receipt says so. It never asks how the invoice will be paid; it
 * asks who paid, as a receipt does, with the receipt's payment as the
 * evidence ("Betald med kort •• 3667"), and with a bank row found it is
 * settled against that row. "Inte betald än" is no answer for it.
 *
 * Pure: codes out, the component turns them into words.
 */
import type { ExtractedPaymentMethod } from '@/types'
import { resolveInboxKind, type InboxDocumentKind } from '@/lib/documents/inbox-kind'
import type { BankMatch } from '@/lib/documents/inbox-bank-match'
import { isUnderlagDivergent, itemHeadline, itemStage, type InkorgItem, type UnderlagStatus } from './items'

export type DecisionAction =
  | 'accept_bank_match'
  | 'register_and_settle'
  | 'pay_in_bank'
  | 'register_invoice'
  | 'match_purchase'
  | 'expense'
  | 'book'
  | 'unmatch'
  | 'not_underlag'
  | 'retry_reading'
  | 'credit'
  | 'open_entry'
  | 'open_supplier_invoice'
  | 'open_matched_entry'
  | 'pay_in_bank_unregistered'
  | 'wait_for_payment'
  | 'owner_paid'
  | 'turn_on_supplier_invoices'
  | 'turn_on_expenses'

export type DecisionQuestion =
  | 'already_paid'
  | 'reading'
  | 'unreadable'
  | 'invoice_paid'
  | 'who_paid'
  | 'credit_note'
  | 'book_purchase'
  | 'underlag_off_entry'
  | 'booked'
  | 'supplier_invoice_done'

export type DecisionEvidence =
  | { kind: 'reading' }
  | { kind: 'unreadable' }
  | { kind: 'due'; date: string }
  | { kind: 'issued'; date: string }
  | { kind: 'paid_with'; method: ExtractedPaymentMethod; cardLast4: string | null }
  | { kind: 'amount'; amount: number; currency: string; date: string | null }
  | { kind: 'linked_purchase' }
  | { kind: 'underlag_status'; status: Exclude<UnderlagStatus, 'anchored'> }
  | { kind: 'credit_note' }
  | { kind: 'booked' }
  | {
      kind: 'bank_match'
      transactionId: string
      date: string
      amount: number
      currency: string
      counterparty: string | null
      /** What paired them: the OCR, the payee's giro, or the amount near the date. */
      basis: BankMatch['basis']
      level: BankMatch['evidence_level']
    }

export interface FocusDecision {
  question: DecisionQuestion
  evidence: DecisionEvidence | null
  /** At most three, the first one primary. */
  actions: DecisionAction[]
  /** Answers that fell off the three, still reachable as a quiet link under them. */
  quietActions: DecisionAction[]
  /** The verifikat editor stays reachable under the answers, as in the workspace (its escape hatch). */
  editorEscape: boolean
}

export const MAX_DECISION_ACTIONS = 3

/** What the company can start, as far as the Inkorg's answers go. */
export interface InkorgStartable {
  /** Leverantörsfakturor och betalningar is on: a supplier invoice can be registered. */
  supplierInvoices: boolean
  /** Utlägg is on: an expense claim can be started. */
  expenses: boolean
  /** An enskild firma: a cost paid with the owner's own money is an egen insättning. */
  soleTrader: boolean
  /** Kontantmetoden: a purchase is booked when it is paid. */
  cashMethod: boolean
}

/** Every package on: the Inkorg as it was before packages could be switched off. */
export const ALL_STARTABLE: InkorgStartable = Object.freeze({
  supplierInvoices: true,
  expenses: true,
  soleTrader: false,
  cashMethod: false,
})

/** Who else paid a receipt, when the company account did not: the utlägg, the owner, or Anpassa. */
function privatelyPaid(startable: InkorgStartable): DecisionAction {
  if (startable.expenses) return 'expense'
  return startable.soleTrader ? 'owner_paid' : 'turn_on_expenses'
}

/** What the evidence line says for a document waiting for its first decision. */
function firstDecisionEvidence(item: InkorgItem, kind: InboxDocumentKind | null): DecisionEvidence | null {
  const data = item.extracted_data
  const headline = itemHeadline(item)
  if (kind === 'supplier_invoice') {
    if (data?.invoice?.dueDate) return { kind: 'due', date: data.invoice.dueDate }
    if (data?.invoice?.invoiceDate) return { kind: 'issued', date: data.invoice.invoiceDate }
  }
  const method = data?.payment?.method
  if (method) return { kind: 'paid_with', method, cardLast4: data?.payment?.cardLast4 ?? null }
  if (headline.amount != null) {
    return { kind: 'amount', amount: headline.amount, currency: headline.currency, date: headline.documentDate }
  }
  return null
}

/** The evidence a paid invoice's receipt gives: how it was paid, else the invoice's own amount. */
function receiptEvidence(item: InkorgItem, companion: InkorgItem | null): DecisionEvidence | null {
  const payment = companion?.extracted_data?.payment
  if (payment?.method) return { kind: 'paid_with', method: payment.method, cardLast4: payment.cardLast4 ?? null }
  const headline = itemHeadline(item)
  return headline.amount != null ? { kind: 'amount', amount: headline.amount, currency: headline.currency, date: headline.documentDate } : null
}

/** An invoice its receipt from the same arrival says is paid (./pairs.ts). */
export function paidByReceipt(item: Pick<InkorgItem, 'pairing' | 'kind_hint' | 'extracted_data'>): boolean {
  return item.pairing?.role === 'invoice' && resolveInboxKind({ kind_hint: item.kind_hint ?? null, extracted_data: item.extracted_data }) === 'supplier_invoice'
}

export function focusDecision(
  item: InkorgItem,
  context: {
    bankMatch?: BankMatch | null
    startable?: InkorgStartable
    /** The receipt the invoice came with as one purchase (its pairing), when the list has it. */
    companion?: InkorgItem | null
  } = {},
): FocusDecision {
  const stage = itemStage(item)
  const startable = context.startable ?? ALL_STARTABLE

  if (stage === 'booked') {
    if (item.created_supplier_invoice_id) {
      return { question: 'supplier_invoice_done', evidence: null, actions: ['open_supplier_invoice'], quietActions: [], editorEscape: false }
    }
    return { question: 'booked', evidence: { kind: 'booked' }, actions: ['open_entry'], quietActions: [], editorEscape: false }
  }

  if (stage === 'processing') {
    return { question: 'reading', evidence: { kind: 'reading' }, actions: [], quietActions: [], editorEscape: false }
  }

  if (stage === 'error') {
    return {
      question: 'unreadable',
      evidence: { kind: 'unreadable' },
      actions: item.document_id ? ['retry_reading', 'not_underlag'] : ['not_underlag'],
      quietActions: [],
      editorEscape: false,
    }
  }

  if (stage === 'linked') {
    if (isUnderlagDivergent(item)) {
      const status = (item.underlag_status ?? 'unknown') as Exclude<UnderlagStatus, 'anchored'>
      return {
        question: 'underlag_off_entry',
        evidence: { kind: 'underlag_status', status },
        actions: ['open_matched_entry', 'unmatch'],
        quietActions: [],
        editorEscape: false,
      }
    }
    return { question: 'book_purchase', evidence: { kind: 'linked_purchase' }, actions: ['book', 'unmatch'], quietActions: [], editorEscape: false }
  }

  // Waiting for the first decision.
  const kind = itemHeadline(item).kind
  const match = context.bankMatch
  const paid = paidByReceipt(item)
  if (match && kind !== 'credit_note') {
    // The bank was checked when it arrived: it looks paid already, by this row.
    // Yes: an invoice is registered and settled against it (the supplier
    // ledger sees both), a receipt is linked to it. Another row: the picker.
    // No: an invoice is registered unpaid; a receipt was an utlägg after all.
    // Dropping it falls off the three and stays a quiet link.
    // Without Leverantörsfakturor a paid invoice is linked to its row and
    // booked with it, like a receipt; "No" then means it waits for its
    // payment (kontantmetoden) or needs the package (faktureringsmetoden).
    // An invoice its receipt says is paid has no "not paid": the third
    // answer is the receipt's, someone paid it privately.
    const actions: DecisionAction[] =
      kind === 'supplier_invoice'
        ? startable.supplierInvoices
          ? ['register_and_settle', 'match_purchase', paid ? privatelyPaid(startable) : 'register_invoice']
          : [
              'accept_bank_match',
              'match_purchase',
              paid ? privatelyPaid(startable) : startable.cashMethod ? 'wait_for_payment' : 'turn_on_supplier_invoices',
            ]
        : ['accept_bank_match', 'match_purchase', privatelyPaid(startable)]
    return {
      question: 'already_paid',
      evidence: {
        kind: 'bank_match',
        transactionId: match.transaction_id,
        date: match.date,
        amount: match.amount,
        currency: match.currency,
        counterparty: match.counterparty,
        basis: match.basis,
        level: match.evidence_level,
      },
      actions,
      quietActions: ['not_underlag'],
      editorEscape: true,
    }
  }
  if (paid) {
    // Paid, by the receipt it came with, and no bank row found for it: who
    // paid decides the booking, as for the receipt itself. The company's
    // account means picking the bank row; never "pay it" or "not paid yet".
    return {
      question: 'who_paid',
      evidence: receiptEvidence(item, context.companion ?? null),
      actions: ['match_purchase', privatelyPaid(startable), 'not_underlag'],
      quietActions: [],
      editorEscape: true,
    }
  }
  if (kind === 'credit_note') {
    // A credit note credits the invoice it references, never a payable of its own (#2980).
    return { question: 'credit_note', evidence: { kind: 'credit_note' }, actions: ['credit', 'not_underlag'], quietActions: [], editorEscape: true }
  }
  if (kind === 'supplier_invoice') {
    // Nothing in the bank looks like its payment: register it to pay later,
    // register it and pay it in the bank, or it was paid after all and the
    // person picks the bank row (never "paid" without one). Dropping it
    // falls off the three and stays a quiet link.
    if (!startable.supplierInvoices) {
      // Nothing is registered: under kontantmetoden it is paid from what the
      // document says and booked when the payment reaches the bank (an
      // enskild firma may have paid it privately); faktureringsmetoden books
      // it as a debt when it arrives, which is what Leverantörsfakturor does.
      const actions: DecisionAction[] = startable.cashMethod
        ? ['pay_in_bank_unregistered', 'match_purchase', ...(startable.soleTrader ? (['owner_paid'] as const) : [])]
        : ['turn_on_supplier_invoices', 'match_purchase']
      return {
        question: 'invoice_paid',
        evidence: firstDecisionEvidence(item, kind),
        actions,
        quietActions: ['not_underlag'],
        editorEscape: true,
      }
    }
    return {
      question: 'invoice_paid',
      evidence: firstDecisionEvidence(item, kind),
      actions: ['register_invoice', 'pay_in_bank', 'match_purchase'],
      quietActions: ['not_underlag'],
      editorEscape: true,
    }
  }
  // A receipt, a letter or an unread document: who paid decides the booking.
  return {
    question: 'who_paid',
    evidence: firstDecisionEvidence(item, kind),
    actions: ['match_purchase', privatelyPaid(startable), 'not_underlag'],
    quietActions: [],
    editorEscape: true,
  }
}

/**
 * The actions an existing endpoint can truly undo, and how: a match is
 * released by unmatch-transaction, and a released match is made again by
 * match-transaction with the transaction it had (both sides restore the
 * transaction's document pin the same way). Everything else posts a
 * verifikat or a supplier invoice (undone only by a correction, never by
 * Ångra) or deletes the item, so it gets no Ångra.
 */
export const UNDO_OF: Readonly<Partial<Record<DecisionAction, 'unmatch' | 'rematch'>>> = {
  match_purchase: 'unmatch',
  accept_bank_match: 'unmatch',
  unmatch: 'rematch',
}

export function canUndo(action: DecisionAction): boolean {
  return UNDO_OF[action] !== undefined
}

/**
 * What a list row says about where an item stands, from what the list knows:
 *   - looks_paid: a bank row it looks paid by (match on arrival), from the
 *     first sight: the list read carries the stored proposal, checked against
 *     its bank row for the whole page at once;
 *   - paid_by_receipt: an invoice the receipt it came with says is paid,
 *     no bank row found for it yet;
 *   - to_pay: an invoice with a due date that nothing says is paid;
 *   - unreadable, reading, linked: its stage;
 *   - waiting: everything else waiting for a decision;
 *   - done: booked or registered.
 * `bankMatch` is what a later read said (the focus view reads the item again
 * when it opens): it wins, null included (the row was booked or claimed
 * since). Undefined leaves the list's own.
 */
export type RowStatus =
  | { kind: 'looks_paid' }
  | { kind: 'paid_by_receipt' }
  | { kind: 'to_pay'; dueDate: string }
  | { kind: 'unreadable' }
  | { kind: 'reading' }
  | { kind: 'linked' }
  | { kind: 'waiting' }
  | { kind: 'done' }

export function rowStatus(item: InkorgItem, bankMatch: BankMatch | null | undefined = item.bank_match): RowStatus {
  const stage = itemStage(item)
  if (stage === 'booked') return { kind: 'done' }
  if (stage === 'processing') return { kind: 'reading' }
  if (stage === 'error') return { kind: 'unreadable' }
  if (stage === 'linked') return { kind: 'linked' }
  const kind = itemHeadline(item).kind
  if (bankMatch && kind !== 'credit_note') return { kind: 'looks_paid' }
  if (paidByReceipt(item)) return { kind: 'paid_by_receipt' }
  const due = item.extracted_data?.invoice?.dueDate
  if (kind === 'supplier_invoice' && due) return { kind: 'to_pay', dueDate: due }
  return { kind: 'waiting' }
}

/** A journal line as a booking proposal carries it. */
interface ProposedLine {
  account_number: string
  debit_amount: number
}

/**
 * The account a proposal books the purchase on: its largest debit line,
 * which for a purchase is the net cost (larger than its VAT; the bank or
 * the payable is the credit side). Null when the proposal has no debit.
 * Read off the proposal's own lines, so no chart is assumed here.
 */
export function bookedOnAccount(lines: readonly ProposedLine[] | null | undefined): string | null {
  let best: ProposedLine | null = null
  for (const line of lines ?? []) {
    if (!(line.debit_amount > 0)) continue
    if (!best || line.debit_amount > best.debit_amount) best = line
  }
  return best?.account_number ?? null
}
