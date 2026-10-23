/**
 * Which bank row, if any, already paid an underlag: the decision of match on
 * arrival, over rows that nothing else claims
 * (lib/documents/inbox-bank-match.ts searchProposableBankRows).
 *
 * Not a new matcher. The underlag is handed to the bank feed's own
 * supplier-invoice matcher (lib/invoices/supplier-invoice-matching.ts,
 * findSupplierInvoiceMatch) as if it were a registered invoice, so a pair is
 * proposed here when the bank feed would have paired the same row with the
 * invoice once registered; the receipt matcher
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
 *          document's or its supplier's (the matcher's bankgiro pass), or
 *          the row's reference or counterparty account is the clearing and
 *          account number inside the document's Swedish IBAN (a giro by
 *          another number); on a day from the payment window's start on,
 *          however late: the matcher's pass reads no date at all, and an
 *          invoice paid weeks after its due date is paid all the same. Never
 *          before the window: that is the last period's payment to the same
 *          giro;
 *   trolig the amount agrees (to the öre, the matcher's amount-and-date
 *          pass; or within the receipt matcher's converted tolerance when the
 *          row is in another currency), inside the window, and the row names
 *          the counterparty or its alias; or, in place of the name, the card
 *          (below). An invoice paid after its window on the name alone:
 *          the amount to the öre in one currency, at most LATE_PAYMENT_DAYS
 *          after the due date (./facts.ts), and no giro on the row that names
 *          another payee.
 * The card the document (or the receipt it came with) says paid it weighs in
 * on the two lower levels (./card-token.ts):
 *   - the row names that card, and trolig holds to the öre in one currency:
 *     stark (the amount, the name, the window and the card all agree);
 *   - the row names that card and the amount agrees to the öre in one
 *     currency inside the window, but no name agrees: trolig, never higher.
 *     A card statement prints the brand the card network knows, not the
 *     seller on the document ("X CORP. PAID FEATURES K3667" for an invoice
 *     from X Internet Unlimited Company), so the card stands in for the
 *     name; without the name it never reaches stark;
 *   - the row names another card: another payment, never proposed below
 *     exakt.
 * A card never helps a converted amount (another currency, the tolerance)
 * or a row it does not name: it identifies the payer's card, not the payee.
 * A receipt is paid the day it is dated: never late.
 *
 * A late payment (a row after the window) is a claim another open item may
 * hold better: a company that pays the same amount to the same payee every
 * month pays this month's invoice on a day after last month's window. The
 * caller passes the other open items the row could pay (BankMatchRival, read
 * as the item itself is read), and a late claim gives the row up when a rival
 * holds it inside its own window (or by its OCR), at a higher level, or at the
 * same level as near its own span or nearer; as near means neither gets it,
 * since the date cannot say whose it is. A claim inside the window is decided
 * as it always was, so a late claim never proposes a row another item
 * proposes too.
 *
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
import { paymentWindow, windowDueDate, type BankMatchFacts, type PaymentWindow } from './facts'

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

/** Another open item a bank row could pay, as it reads: what a late claim on the row is weighed against. */
export interface BankMatchRival {
  facts: BankMatchFacts
  /** Its amount in kronor, as its own check computes it (decideBankMatch's `amountSek`). */
  amountSek: number | null
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
  /** After the payment window: a late payment, which a rival may hold better. Never for exakt. */
  late: boolean
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

/**
 * The clearing and account number inside a Swedish IBAN: SE, two check
 * digits, the bank's three-digit code, then seventeen digits that hold the
 * clearing and account number padded with zeros. Null for any other IBAN,
 * and for an account part under ten digits: a bank whose IBAN leaves the
 * clearing out (Handelsbanken's) never agrees, rather than agreeing wrongly.
 */
function swedishAccountInIban(iban: string | null | undefined): string | null {
  const compact = (iban ?? '').replace(/\s+/g, '').toUpperCase()
  if (!/^SE\d{22}$/.test(compact)) return null
  const account = compact.slice(7).replace(/^0+/, '')
  return account.length >= 10 ? account : null
}

/**
 * The row pays the document's bank account: its reference or counterparty
 * account is, digit for digit, the clearing and account number inside the
 * IBAN the document asks to be paid to. A giro agreement by another number,
 * so it counts as one.
 */
function accountAgrees(facts: BankMatchFacts, row: ProposableBankRow): boolean {
  const account = swedishAccountInIban(facts.iban)
  if (!account) return false
  return [row.reference, row.counterparty_account].some((value) => {
    const text = (value ?? '').trim()
    return /^[\d\s-]+$/.test(text) && text.replace(/\D/g, '').replace(/^0+/, '') === account
  })
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

/**
 * An invoice paid after its window on the name alone: the amount to the öre
 * in one currency, at most LATE_PAYMENT_DAYS after the due date, and no giro
 * on the row that names another payee. Trolig, never more; never on the card
 * alone (a card pays at the purchase) or on a converted amount (a rate's
 * tolerance weeks later is no agreement).
 */
function lateByName(facts: BankMatchFacts, row: ProposableBankRow, rules: BankMatchRules, window: PaymentWindow, distance: number): Scored | null {
  if (row.date > window.lateEnd) return null
  if (!sameAmount(facts, row) || !nameAgrees(facts, row) || giroContradicts(facts, row, rules)) return null
  return { row, level: 'trolig', basis: 'rule_amount_date', distance, late: true }
}

function scoreRow(facts: BankMatchFacts, row: ProposableBankRow, rules: BankMatchRules, amountSek: number | null): Scored | null {
  const transaction = row as unknown as Transaction
  const window = paymentWindow(facts)
  const distance = window ? distanceFromCore(row.date, window.coreStart, window.coreEnd) : 0

  if (facts.reference) {
    const named = rules.matchSupplierInvoice(transaction, [asRegisteredInvoice(facts, amountSek, true)])
    if (named?.matchMethod === 'payment_reference' && sameAmount(facts, row) && !giroContradicts(facts, row, rules)) {
      return { row, level: 'exakt', basis: 'rule_ocr_reference', distance, late: false }
    }
  }

  // Nothing before the window (the last period's payment to the same payee),
  // and a receipt is paid the day it is dated, never late.
  if (window === null || row.date < window.start) return null
  const late = row.date > window.end
  if (late && facts.kind === 'receipt') return null
  // Another card paid this row: another payment, whatever else agrees.
  const card = cardEvidence(facts.cardLast4, rowTexts(row))
  if (card === 'contradicts') return null
  const plain = rules.matchSupplierInvoice(transaction, [asRegisteredInvoice(facts, amountSek, false)])
  // The amount and the payee's giro (or bank account): the matcher's pass
  // reads no date, so neither does this, however late.
  if (plain?.matchMethod === 'amount_bankgiro' || (sameAmount(facts, row) && accountAgrees(facts, row))) {
    return { row, level: 'stark', basis: 'rule_counterparty', distance, late }
  }
  if (late) return lateByName(facts, row, rules, window, distance)
  if (!nameAgrees(facts, row)) {
    // The card in place of the name: the row names the card the document says
    // paid it, the same amount to the öre in one currency, inside the window.
    // Trolig at most: the card names the payer, the name would name the payee.
    if (card === 'agrees' && sameAmount(facts, row)) return { row, level: 'trolig', basis: 'rule_amount_date', distance, late: false }
    return null
  }
  if (plain?.matchMethod === 'amount_date') {
    // The card the document says paid it is the row's: amount, name, window and card agree.
    const level = card === 'agrees' && sameAmount(facts, row) ? 'stark' : 'trolig'
    return { row, level, basis: 'rule_amount_date', distance, late: false }
  }

  // Another currency: the receipt matcher's comparison through kronor, with
  // its tolerance for a card issuer's rate beside Riksbanken's.
  const currency = rowCurrency(row)
  if (currency !== facts.currency && amountSek != null) {
    const rowSek = resolveSekAmountOrNull(row.amount, row.amount_sek, currency, row.exchange_rate)
    if (rowSek == null) return null
    const variance = amountVarianceForMatch(facts.amount, facts.currency, amountSek, row.amount, currency, rowSek)
    if (variance != null && variance <= CONVERTED_AMOUNT_TOLERANCE_PERCENT) {
      return { row, level: 'trolig', basis: 'rule_amount_date', distance, late: false }
    }
  }
  return null
}

function scoreRows(facts: BankMatchFacts, rows: readonly ProposableBankRow[], rules: BankMatchRules, amountSek: number | null): Scored[] {
  return rows.map((row) => scoreRow(facts, row, rules, amountSek)).filter((s): s is Scored => s !== null)
}

/**
 * Whether a late claim gives its row up to a rival's claim on the same row:
 * the rival holds it inside its window or by its OCR, at a higher level, or
 * at the same level as near its own span or nearer (as near: neither).
 */
function yieldsTo(claim: Scored, rival: Scored | null): boolean {
  if (!rival) return false
  if (!rival.late) return true
  const mine = LEVEL_RANK[claim.level]
  const theirs = LEVEL_RANK[rival.level]
  return theirs > mine || (theirs === mine && rival.distance <= claim.distance)
}

/** What the underlag could claim among `rows`, before any rival is weighed. */
export interface BankRowClaims {
  /**
   * Every row it could be paid by: another item's standing proposal of one of
   * them may no longer stand once this item arrives or reads differently.
   */
  claimable: ProposableBankRow[]
  /**
   * The late claims that could change the answer, whose rivals must be read
   * before deciding. Empty when a claim inside the window (or the OCR)
   * outranks every late one: a higher level, or the same level and nearer.
   */
  contested: ProposableBankRow[]
}

export function bankRowClaims(
  facts: BankMatchFacts,
  rows: readonly ProposableBankRow[],
  rules: BankMatchRules,
  amountSek: number | null,
): BankRowClaims {
  const scored = scoreRows(facts, rows, rules, amountSek)
  const settled = scored.filter((s) => !s.late)
  const outranked = (late: Scored) =>
    settled.some((s) => LEVEL_RANK[s.level] > LEVEL_RANK[late.level] || (s.level === late.level && s.distance < late.distance))
  return {
    claimable: scored.map((s) => s.row),
    contested: scored.filter((s) => s.late && !outranked(s)).map((s) => s.row),
  }
}

/**
 * The bank row that already paid the underlag, or null.
 *
 * `amountSek`: the underlag's amount in kronor (itself for a kronor
 * document, through Riksbanken's rate otherwise), or null when no rate could
 * be had: then a row in another currency is never proposed.
 *
 * `rivals`: the other open items the rows could pay (bankRowClaims says when
 * they are needed). A late claim a rival holds better is never proposed.
 */
export function decideBankMatch(
  facts: BankMatchFacts,
  rows: readonly ProposableBankRow[],
  rules: BankMatchRules,
  amountSek: number | null,
  rivals: readonly BankMatchRival[] = [],
): BankMatchDecision | null {
  const scored = scoreRows(facts, rows, rules, amountSek).filter(
    (s) => !s.late || !rivals.some((rival) => yieldsTo(s, scoreRow(rival.facts, s.row, rules, rival.amountSek))),
  )
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
