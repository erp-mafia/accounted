/**
 * Which bank payment order a debit in the bank feed is the debit of.
 *
 * Pure: the callers (ingest step 3a and the status sync's sweep) load the
 * open orders and the debit rows, this module only decides. The decision
 * books money (settleOrderWithDebit), so the rules are narrow and ordered:
 *
 *   (a) the debit carries the order's end-to-end id, compared without regard
 *       to case (banks have echoed it in capitals): the bank itself names the
 *       payment. Confidence 0.99.
 *   (b) otherwise the debit must move exactly the order's amount in the
 *       order's currency, from the order's account (a debit the feed could
 *       not bind to an account may still match), on a day in
 *       [requested_execution_date - 1, requested_execution_date + 3] by its
 *       booking date or its value date. Exactly one such order: 0.95. Payee
 *       evidence raises that to 0.98 and decides between several orders that
 *       satisfy (b): the payee's bankgiro or plusgiro digits in the text
 *       (Swedbank writes the bankgiro zero-padded, '0000055778815' carries
 *       '55778815'; a hyphen inside the number is allowed), the payee IBAN
 *       as the counterparty IBAN, or the payee name's significant words in
 *       the description. Several candidates and no evidence: no match.
 *
 * A debit that carries one of OUR end-to-end ids but names none of the open
 * orders is another payment of ours (settled already, or in another state):
 * it never matches by amount, the same rule the settlement trigger applies.
 *
 * An order without a supplier invoice (purpose skattekonto, salary) is never
 * booked by its debit: the row is booked the way it always is (the
 * skattekonto account, the salary voucher). Its debit only links the order
 * (findLinkableOrderForDebit), and since that moves the order to executed,
 * a final status, the rule is stricter: the order is signed, the debit is
 * from the order's own account, and besides amount and day it names the
 * order (its end-to-end id, its payee, or its own OCR number or message).
 */

import { addDaysIso } from '@/lib/dates/iso'
import { roundOre } from '@/lib/money'
import type { Transaction } from '@/types'
import type { PaymentOrderStatus } from './status'
import type { PaymentOrderRow } from './types'

/** Days before and after requested_execution_date a debit may land on and still be the order's. */
export const DEBIT_WINDOW_DAYS_BEFORE = 1
export const DEBIT_WINDOW_DAYS_AFTER = 3

/** Orders whose own debit may settle them without a person: signed at the bank, not yet matched. */
export const DEBIT_SETTLEABLE_ORDER_STATUSES: readonly PaymentOrderStatus[] = [
  'accepted',
  'awaiting_second_signer',
  'executed',
]

/** The end-to-end id shape Accounted gives its own payments (prepare.ts). */
const OWN_END_TO_END_ID = /^ACC[0-9a-f]{32}$/i

/** The debit as the matcher reads it: the stored transaction row, or the raw row before insert. */
export interface OrderDebit {
  /** Negative: money left the account. */
  amount: number
  currency: string | null
  /** Booking date, YYYY-MM-DD. */
  date: string
  /** Value date as the bank reports it, when it does. */
  value_date?: string | null
  cash_account_id: string | null
  description: string | null
  reference?: string | null
  counterparty_iban?: string | null
  counterparty_account?: string | null
  end_to_end_id?: string | null
}

export type DebitMatchCandidate = Pick<
  PaymentOrderRow,
  | 'id'
  | 'status'
  | 'supplier_invoice_id'
  | 'supplier_invoice_payment_id'
  | 'provider_payment_id'
  | 'amount'
  | 'currency'
  | 'requested_execution_date'
  | 'cash_account_id'
  | 'end_to_end_id'
  | 'payee_bankgiro'
  | 'payee_plusgiro'
  | 'payee_iban'
  | 'payee_name'
>

/** What decided the match, kept in the match log and the order's event. */
export type DebitMatchBasis = 'end_to_end_id' | 'amount_account_date' | 'payee'

export interface DebitOrderMatch<T extends DebitMatchCandidate> {
  order: T
  confidence: number
  basis: DebitMatchBasis
}

/** An order its own debit may settle: signed at the bank, with an invoice, not yet matched. */
export function isDebitSettleableOrder(order: DebitMatchCandidate): boolean {
  return (
    DEBIT_SETTLEABLE_ORDER_STATUSES.includes(order.status) &&
    order.supplier_invoice_payment_id == null &&
    order.supplier_invoice_id != null &&
    order.provider_payment_id != null
  )
}

function sameAmount(debit: OrderDebit, order: DebitMatchCandidate): boolean {
  if (!(debit.amount < 0)) return false
  if ((debit.currency ?? 'SEK') !== order.currency) return false
  return roundOre(Math.abs(debit.amount)) === roundOre(Number(order.amount))
}

function sameAccount(debit: OrderDebit, order: DebitMatchCandidate): boolean {
  return debit.cash_account_id == null || debit.cash_account_id === order.cash_account_id
}

/** Whether the debit's booking date or value date lies in the order's execution window. */
export function debitInExecutionWindow(debit: OrderDebit, order: Pick<DebitMatchCandidate, 'requested_execution_date'>): boolean {
  const from = addDaysIso(order.requested_execution_date, -DEBIT_WINDOW_DAYS_BEFORE)
  const to = addDaysIso(order.requested_execution_date, DEBIT_WINDOW_DAYS_AFTER)
  const inWindow = (day: string | null | undefined) => Boolean(day) && (day as string) >= from && (day as string) <= to
  return inWindow(debit.date) || inWindow(debit.value_date)
}

/**
 * Whether `text` carries the giro number: its digits in order, a hyphen
 * allowed between any two of them, any number of leading zeros, and no other
 * digit touching it. '0000055778815', '5577-8815' and '55778815' all carry
 * 55778815; '155778815' does not.
 */
function containsGiroNumber(text: string | null | undefined, giro: string | null): boolean {
  if (!text || !giro) return false
  const digits = giro.replace(/\D/g, '')
  // Short plusgiro numbers exist, but a run of four digits or fewer is in too
  // many bank texts (amounts, dates) to count as evidence.
  if (digits.length < 5) return false
  const pattern = new RegExp(`(?:^|\\D)0*${digits.split('').join('-?')}(?:\\D|$)`)
  return pattern.test(text)
}

function normalizeIban(iban: string | null | undefined): string | null {
  const normalized = iban?.replace(/\s+/g, '').toUpperCase() ?? ''
  return normalized.length >= 15 ? normalized : null
}

/** Lower-cased with diacritics removed, so 'Åkeri' and 'AKERI' compare equal. */
function foldText(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** Legal forms and filler that every other name shares and so prove nothing. */
const NAME_NOISE = new Set([
  'ab', 'hb', 'kb', 'ek', 'for', 'ekonomisk', 'forening', 'ltd', 'limited', 'inc', 'llc', 'gmbh', 'oy', 'oyj',
  'as', 'asa', 'aps', 'bv', 'sa', 'plc', 'co', 'the', 'och', 'and', 'of', 'in', 'sweden', 'sverige', 'nordic',
  'group', 'holding', 'publ',
])

function significantNameTokens(name: string | null | undefined): string[] {
  if (!name) return []
  return foldText(name)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !NAME_NOISE.has(token))
}

/**
 * Whether the description names the payee: at least half of the name's
 * significant words appear in it (banks truncate names), one of them at least
 * four characters long.
 */
function descriptionNamesPayee(description: string | null | undefined, payeeName: string | null): boolean {
  if (!description) return false
  const tokens = significantNameTokens(payeeName)
  if (tokens.length === 0) return false
  const text = foldText(description)
  const found = tokens.filter((token) => text.includes(token))
  return found.length >= Math.ceil(tokens.length / 2) && found.some((token) => token.length >= 4)
}

/**
 * Whether the debit's text or counterparty names the order's payee: the
 * bankgiro or plusgiro digits in the description, the reference or the
 * counterparty account, the payee IBAN as the counterparty IBAN, or the payee
 * name in the description.
 */
export function debitNamesPayee(debit: OrderDebit, order: DebitMatchCandidate): boolean {
  const texts = [debit.description, debit.reference, debit.counterparty_account]
  for (const giro of [order.payee_bankgiro, order.payee_plusgiro]) {
    if (giro && texts.some((text) => containsGiroNumber(text, giro))) return true
  }
  const payeeIban = normalizeIban(order.payee_iban)
  if (payeeIban && payeeIban === normalizeIban(debit.counterparty_iban)) return true
  return descriptionNamesPayee(debit.description, order.payee_name)
}

/**
 * The open order this debit settles, or null. `candidates` are the company's
 * open orders (loadOpenPaymentOrders); anything not settleable is ignored
 * here too, so a stale list cannot book against a closed order.
 */
export function findOrderForDebit<T extends DebitMatchCandidate>(
  debit: OrderDebit,
  candidates: readonly T[],
): DebitOrderMatch<T> | null {
  const open = candidates.filter(isDebitSettleableOrder)
  if (open.length === 0) return null

  const endToEndId = debit.end_to_end_id?.trim().toLowerCase() ?? ''
  if (endToEndId) {
    const named = open.filter((order) => order.end_to_end_id.toLowerCase() === endToEndId)
    if (named.length === 1) return { order: named[0], confidence: 0.99, basis: 'end_to_end_id' }
    // Two open orders with one id cannot exist; one of ours naming none of
    // them is another payment, never settled here by its amount.
    if (named.length > 1 || OWN_END_TO_END_ID.test(endToEndId)) return null
  }

  const byShape = open.filter(
    (order) => sameAmount(debit, order) && sameAccount(debit, order) && debitInExecutionWindow(debit, order),
  )
  if (byShape.length === 0) return null
  const withPayee = byShape.filter((order) => debitNamesPayee(debit, order))
  if (byShape.length === 1) {
    return withPayee.length === 1
      ? { order: byShape[0], confidence: 0.98, basis: 'payee' }
      : { order: byShape[0], confidence: 0.95, basis: 'amount_account_date' }
  }
  if (withPayee.length === 1) return { order: withPayee[0], confidence: 0.98, basis: 'payee' }
  return null
}

/**
 * Orders without a supplier invoice whose own debit may link them: at the
 * bank and signed. awaiting_signature is here for a signing that finished
 * while the bank still answers RCVD (isBankConfirming): such an order counts
 * only with signed_at, its own or its signing's (withFinishedSignings fills
 * it in from the batch).
 */
export const DEBIT_LINKABLE_ORDER_STATUSES: readonly PaymentOrderStatus[] = [
  'awaiting_signature',
  'awaiting_second_signer',
  'accepted',
  'executed',
]

export type DebitLinkCandidate = DebitMatchCandidate &
  Pick<PaymentOrderRow, 'purpose' | 'signed_at' | 'matched_transaction_id' | 'reference' | 'payee_account'>

/** What named the order in its debit besides amount, account and day, kept in the order's 'matched' event. */
export type DebitLinkBasis = 'end_to_end_id' | 'payee' | 'reference'

export interface DebitOrderLink<T extends DebitLinkCandidate> {
  order: T
  basis: DebitLinkBasis
}

/** An order without an invoice its own debit may link: signed, at the bank, not yet linked. */
export function isDebitLinkableOrder(order: DebitLinkCandidate): boolean {
  return (
    order.purpose !== 'supplier_invoice' &&
    order.supplier_invoice_id == null &&
    DEBIT_LINKABLE_ORDER_STATUSES.includes(order.status) &&
    (order.status !== 'awaiting_signature' || order.signed_at != null) &&
    order.matched_transaction_id == null &&
    order.supplier_invoice_payment_id == null &&
    order.provider_payment_id != null
  )
}

/** A reference shorter than this ('Lön' alone, a short message) is in too many texts to count as evidence. */
const MIN_REFERENCE_EVIDENCE = 6

function foldSpaces(text: string): string {
  return foldText(text).replace(/\s+/g, ' ').trim()
}

/**
 * Whether the debit's text carries the order's own reference: an OCR number
 * as a run of its digits (containsGiroNumber), a message ('Lön 2026-10')
 * compared folded, so 'LÖN 2026-10' carries it.
 */
function debitCarriesReference(debit: OrderDebit, reference: string | null): boolean {
  const wanted = foldSpaces(reference ?? '')
  if (wanted.length < MIN_REFERENCE_EVIDENCE) return false
  const texts = [debit.description, debit.reference]
  if (/^\d+$/.test(wanted)) return texts.some((text) => containsGiroNumber(text, wanted))
  return texts.some((text) => Boolean(text) && foldSpaces(text as string).includes(wanted))
}

/**
 * Whether the debit names the payee's bank account: its digits in the text,
 * or the counterparty account ending in them (banks prefix the clearing
 * number, some zero-padded). At least five digits.
 */
function debitNamesPayeeAccount(debit: OrderDebit, order: DebitLinkCandidate): boolean {
  const account = order.payee_account?.replace(/\D/g, '') ?? ''
  if (account.length < 5) return false
  const counterparty = debit.counterparty_account?.replace(/\D/g, '') ?? ''
  if (counterparty.endsWith(account)) return true
  return [debit.description, debit.reference].some((text) => containsGiroNumber(text, account))
}

/** What in the debit names this order besides its amount, or null when nothing does. */
export function debitLinkEvidence(debit: OrderDebit, order: DebitLinkCandidate): DebitLinkBasis | null {
  const endToEndId = debit.end_to_end_id?.trim().toLowerCase() ?? ''
  if (endToEndId && endToEndId === order.end_to_end_id.toLowerCase()) return 'end_to_end_id'
  if (debitNamesPayee(debit, order) || debitNamesPayeeAccount(debit, order)) return 'payee'
  if (debitCarriesReference(debit, order.reference)) return 'reference'
  return null
}

/**
 * The order without an invoice this debit is the payment of, or null.
 * `candidates` are the company's orders (loadOpenPaymentOrders, or the
 * status sync's read); anything not linkable is ignored here too. The debit
 * moves exactly the order's amount from the order's own account on a day of
 * its execution window, and names it (debitLinkEvidence). Two such orders
 * are told apart only by the payee or the end-to-end id, never guessed: a
 * salary run's message is the same on every employee's payment.
 */
export function findLinkableOrderForDebit<T extends DebitLinkCandidate>(
  debit: OrderDebit,
  candidates: readonly T[],
): DebitOrderLink<T> | null {
  const open = candidates.filter(isDebitLinkableOrder)
  if (open.length === 0) return null
  const fits = (order: T) =>
    sameAmount(debit, order) && debit.cash_account_id === order.cash_account_id && debitInExecutionWindow(debit, order)

  const endToEndId = debit.end_to_end_id?.trim().toLowerCase() ?? ''
  if (endToEndId) {
    const named = open.filter((order) => order.end_to_end_id.toLowerCase() === endToEndId)
    if (named.length === 1) return fits(named[0]) ? { order: named[0], basis: 'end_to_end_id' } : null
    if (named.length > 1 || OWN_END_TO_END_ID.test(endToEndId)) return null
  }

  const byShape = open.filter(fits)
  if (byShape.length === 1) {
    const basis = debitLinkEvidence(debit, byShape[0])
    return basis ? { order: byShape[0], basis } : null
  }
  const byPayee = byShape.filter((order) => debitLinkEvidence(debit, order) === 'payee')
  return byPayee.length === 1 ? { order: byPayee[0], basis: 'payee' } : null
}

/** A stored transactions row as the matchers read it. */
export function debitOfTransaction(row: Transaction): OrderDebit {
  return {
    amount: row.amount,
    currency: row.currency,
    date: row.date,
    value_date: row.value_date ?? null,
    cash_account_id: row.cash_account_id,
    description: row.original_description ?? row.description,
    reference: row.reference,
    counterparty_iban: row.counterparty_iban,
    counterparty_account: row.counterparty_account,
    end_to_end_id: row.end_to_end_id ?? null,
  }
}
