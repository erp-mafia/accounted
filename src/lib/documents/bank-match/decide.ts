/**
 * Which bank row, if any, already paid an underlag: the decision of match on
 * arrival, over rows that nothing else claims
 * (lib/documents/inbox-bank-match.ts searchProposableBankRows).
 *
 * Not a new matcher. The underlag is handed to the bank feed's own
 * supplier-invoice matcher (lib/invoices/supplier-invoice-matching.ts,
 * findSupplierInvoiceMatch) as if it were a registered invoice, so a pair is
 * proposed here exactly when the bank feed would have paired the same row
 * with the invoice once registered; the receipt matcher
 * (lib/documents/core-receipt-matcher.ts) supplies the name agreement and
 * the comparison of amounts in two currencies. The invoicing and transactions
 * blocks own the first two rules and this block may not import them, so the
 * caller passes them in (BankMatchRules), as with the reading's PeppolReader.
 *
 * The levels, never a score:
 *   exakt  the OCR names the row (the matcher's reference pass) and the
 *          amount agrees to the öre in one currency; a giro the row carries
 *          does not contradict the document's;
 *   stark  the amount agrees to the öre and the row's payee giro is the
 *          document's or its supplier's (the matcher's bankgiro pass), on a
 *          day inside the payment window;
 *   trolig the amount agrees (to the öre, the matcher's amount-and-date
 *          pass; or within the receipt matcher's converted tolerance when the
 *          row is in another currency), inside the window, and the row names
 *          the counterparty or its alias.
 * The card the document (or the receipt it came with) says paid it weighs in
 * on the two lower levels, never on its own (./card-token.ts):
 *   - the row names that card, and trolig holds to the öre in one currency:
 *     stark (the amount, the name, the window and the card all agree);
 *   - the row names another card: another payment, never proposed below
 *     exakt.
 * A card never makes a proposal the rules above would not: it identifies
 * the payer's card, not the payee, so the name still has to agree.
 * Among rows at the best level the one nearest the issue-to-due span wins; a
 * tie the date cannot break proposes nothing, since a proposal is a claim
 * about one row. Two rows the OCR names (a payment made twice) give the
 * first. Pure: no client, no I/O.
 */
import {
  CONVERTED_AMOUNT_TOLERANCE_PERCENT,
  amountVarianceForMatch,
  calculateMerchantSimilarity,
} from '@/lib/documents/core-receipt-matcher'
import type { BankMatchBasis, BankMatchEvidenceLevel, ProposableBankRow } from '@/lib/documents/inbox-bank-match'
import { resolveSekAmountOrNull } from '@/lib/bookkeeping/currency-utils'
import { daysBetweenIso } from '@/lib/dates/iso'
import type { SupplierInvoiceMatch } from '@/lib/invoices/supplier-invoice-matching'
import type { GiroRow } from '@/lib/transactions/giro-counterparty'
import type { SupplierInvoice, Transaction } from '@/types'
import { cardEvidence } from './card-token'
import { paymentWindow, windowDueDate, type BankMatchFacts } from './facts'

/** The rules this block reuses from the blocks that own them; the caller passes them in. */
export interface BankMatchRules {
  /** lib/invoices/supplier-invoice-matching.ts findSupplierInvoiceMatch: the bank feed's passes for every new debit. */
  matchSupplierInvoice: (transaction: Transaction, invoices: SupplierInvoice[]) => SupplierInvoiceMatch | null
  /** lib/transactions/giro-counterparty.ts counterpartyGiroDigits: the giro numbers a bank row names its counterparty by. */
  counterpartyGiroDigits: (row: GiroRow) => string[]
  /** lib/transactions/giro-counterparty.ts giroKey: a giro number as digits without leading zeros. */
  giroKey: (value: string | null | undefined) => string
}

export interface BankMatchDecision {
  transactionId: string
  basis: BankMatchBasis
  evidenceLevel: BankMatchEvidenceLevel
}

/** Name agreement for trolig: substring, token-subset or near-identical names (the receipt matcher's scale). */
export const NAME_AGREEMENT = 0.8

const LEVEL_RANK: Record<BankMatchEvidenceLevel, number> = { exakt: 3, stark: 2, trolig: 1 }

interface Scored {
  row: ProposableBankRow
  level: BankMatchEvidenceLevel
  basis: BankMatchBasis
  /** Days outside the issue-to-due span; 0 inside it. */
  distance: number
}

function rowCurrency(row: ProposableBankRow): string {
  return (row.currency ?? 'SEK').toUpperCase()
}

/**
 * The underlag as the supplier-invoice matcher reads a registered invoice:
 * its amount as the remainder, its OCR, its dates (the due date the window
 * implies), its giro and its supplier.
 */
function asRegisteredInvoice(facts: BankMatchFacts, amountSek: number | null, withReference: boolean): SupplierInvoice {
  return {
    id: 'inbox-item',
    status: 'registered',
    total: facts.amount,
    remaining_amount: facts.amount,
    currency: facts.currency,
    total_sek: amountSek,
    exchange_rate: null,
    payment_reference: withReference ? facts.reference : null,
    invoice_date: facts.issueDate,
    due_date: windowDueDate(facts),
    payee_bankgiro: facts.bankgiro,
    payee_plusgiro: facts.plusgiro,
    supplier: { name: facts.names[0] ?? null, bankgiro: facts.supplierBankgiro, plusgiro: facts.supplierPlusgiro },
  } as unknown as SupplierInvoice
}

/** The same amount in the same currency, to the half öre (the matcher's own equality). */
function sameAmount(facts: BankMatchFacts, row: ProposableBankRow): boolean {
  return rowCurrency(row) === facts.currency && Math.abs(Math.abs(row.amount) - facts.amount) < 0.005
}

/** The row names a payee giro and the document names others, none of them the row's. */
function giroContradicts(facts: BankMatchFacts, row: ProposableBankRow, rules: BankMatchRules): boolean {
  const rowGiros = rules.counterpartyGiroDigits(row)
  if (rowGiros.length === 0) return false
  const documentGiros = [facts.bankgiro, facts.plusgiro, facts.supplierBankgiro, facts.supplierPlusgiro]
    .map((giro) => rules.giroKey(giro))
    .filter((giro) => giro !== '')
  if (documentGiros.length === 0) return false
  return !documentGiros.some((giro) => rowGiros.includes(giro))
}

/** What the bank row says about itself in words: the merchant and the bank's texts. */
function rowTexts(row: ProposableBankRow): string[] {
  return [row.merchant_name, row.description, row.original_description].filter((t): t is string => !!t && t.trim() !== '')
}

/** The row names the counterparty, or its alias on the supplier card. */
function nameAgrees(facts: BankMatchFacts, row: ProposableBankRow): boolean {
  const texts = rowTexts(row)
  return facts.names.some((name) => texts.some((t) => calculateMerchantSimilarity(name, t) >= NAME_AGREEMENT))
}

function distanceFromCore(date: string, coreStart: string, coreEnd: string): number {
  if (date < coreStart) return daysBetweenIso(date, coreStart)
  if (date > coreEnd) return daysBetweenIso(coreEnd, date)
  return 0
}

function scoreRow(facts: BankMatchFacts, row: ProposableBankRow, rules: BankMatchRules, amountSek: number | null): Scored | null {
  const transaction = row as unknown as Transaction
  const window = paymentWindow(facts)
  const inWindow = window !== null && row.date >= window.start && row.date <= window.end
  const distance = window ? distanceFromCore(row.date, window.coreStart, window.coreEnd) : 0

  if (facts.reference) {
    const named = rules.matchSupplierInvoice(transaction, [asRegisteredInvoice(facts, amountSek, true)])
    if (named?.matchMethod === 'payment_reference' && sameAmount(facts, row) && !giroContradicts(facts, row, rules)) {
      return { row, level: 'exakt', basis: 'rule_ocr_reference', distance }
    }
  }

  if (!inWindow) return null
  // Another card paid this row: another payment, whatever else agrees.
  const card = cardEvidence(facts.cardLast4, rowTexts(row))
  if (card === 'contradicts') return null
  const plain = rules.matchSupplierInvoice(transaction, [asRegisteredInvoice(facts, amountSek, false)])
  if (plain?.matchMethod === 'amount_bankgiro') return { row, level: 'stark', basis: 'rule_counterparty', distance }
  if (!nameAgrees(facts, row)) return null
  if (plain?.matchMethod === 'amount_date') {
    // The card the document says paid it is the row's: amount, name, window and card agree.
    const level = card === 'agrees' && sameAmount(facts, row) ? 'stark' : 'trolig'
    return { row, level, basis: 'rule_amount_date', distance }
  }

  // Another currency: the receipt matcher's comparison through kronor, with
  // its tolerance for a card issuer's rate beside Riksbanken's.
  const currency = rowCurrency(row)
  if (currency !== facts.currency && amountSek != null) {
    const rowSek = resolveSekAmountOrNull(row.amount, row.amount_sek, currency, row.exchange_rate)
    if (rowSek == null) return null
    const variance = amountVarianceForMatch(facts.amount, facts.currency, amountSek, row.amount, currency, rowSek)
    if (variance != null && variance <= CONVERTED_AMOUNT_TOLERANCE_PERCENT) {
      return { row, level: 'trolig', basis: 'rule_amount_date', distance }
    }
  }
  return null
}

/**
 * The bank row that already paid the underlag, or null.
 *
 * `amountSek`: the underlag's amount in kronor (itself for a kronor
 * document, through Riksbanken's rate otherwise), or null when no rate could
 * be had: then a row in another currency is never proposed.
 */
export function decideBankMatch(
  facts: BankMatchFacts,
  rows: readonly ProposableBankRow[],
  rules: BankMatchRules,
  amountSek: number | null,
): BankMatchDecision | null {
  const scored = rows.map((row) => scoreRow(facts, row, rules, amountSek)).filter((s): s is Scored => s !== null)
  if (scored.length === 0) return null
  const best = Math.max(...scored.map((s) => LEVEL_RANK[s.level]))
  const top = scored
    .filter((s) => LEVEL_RANK[s.level] === best)
    .sort((a, b) =>
      a.level === 'exakt'
        ? a.row.date.localeCompare(b.row.date) || a.row.id.localeCompare(b.row.id)
        : a.distance - b.distance || a.row.date.localeCompare(b.row.date) || a.row.id.localeCompare(b.row.id),
    )
  const [first, second] = top
  if (first.level !== 'exakt' && second && second.distance === first.distance) return null
  return { transactionId: first.row.id, basis: first.basis, evidenceLevel: first.level }
}
