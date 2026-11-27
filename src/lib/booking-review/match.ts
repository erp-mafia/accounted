/**
 * Hard blocks (accounted#130, step 2): "never book X without me".
 *
 * A booking review rule (booking_review_rules, migration 20261031150000)
 * names what a person always reviews before it is booked: accounts, a
 * counterparty, an amount from, a VAT treatment, or any mix. A booking of a
 * purchase (BOOKING_REVIEW_SOURCES: a bank row, a supplier invoice, an
 * Inkorg underlag or an utlägg) matches when every criterion the rule sets matches:
 *
 *   accounts         the verifikat touches any of them;
 *   counterparty     a party it books (a bank row, the supplier invoice's
 *                    supplier, the underlag's seller) has this identity
 *                    (grantCounterpartyKey, the identity grants are keyed by);
 *   amount from      that same party moves at least this much, in SEK;
 *   VAT treatment    the verifikat's VAT lines carry it (vatClassesFromLines).
 *
 * The counterparty and the amount are judged on one party together, so a
 * samlingsverifikat matches when one of its rows does.
 *
 * Pure and isomorphic. Mirrored in SQL by booking_review_entry_matches and
 * booking_review_vat_classes, which commit_journal_entry asks last: every
 * door asks here first, so a refusal there is the last line, not the first.
 * tests/pg/booking-review-rules.pg.test.ts pins the two together.
 */
import { namesCounterparty, normalizeCounterpartyName } from '@/lib/bookkeeping/counterparty-templates'
import type { JournalEntrySourceType, VatTreatment } from '@/types'
import { bookingVatRole } from '@/lib/vat/moms-box-mapping'
import { roundOre } from '@/lib/money'

/** The VAT a rule names: the treatments a booking's VAT lines tell apart, and none (export, exempt, private). */
export const BOOKING_REVIEW_VAT_CLASSES = ['standard_25', 'reduced_12', 'reduced_6', 'reverse_charge', 'none'] as const
export type BookingReviewVatClass = (typeof BOOKING_REVIEW_VAT_CLASSES)[number]

export interface BookingReviewRule {
  id: string
  /** The rule across its versions: the id of its first version. */
  rule_id: string
  version: number
  accounts: string[] | null
  counterparty_key: string | null
  counterparty_label: string | null
  amount_from_sek: number | null
  vat_treatment: BookingReviewVatClass | null
  note: string | null
  valid_from: string
  created_by: string
  created_at: string
  revoked_at: string | null
  revoked_by: string | null
  revoked_reason: 'archived' | 'superseded' | null
}

/**
 * What a rule judges a journal entry by, per source type: the parties it
 * books, besides its lines (mirror of booking_review_entry_matches and
 * booking_review_entry_parties, migration 20261109170100):
 *
 *   bank_rows         the bank rows it books (bank_booking_context); a draft
 *                     that books none is never matched;
 *   supplier_invoice  the supplier invoice it registers, or under
 *                     kontantmetoden pays (then also its bank rows): the
 *                     supplier card's name and the invoice total in SEK;
 *   inbox_item        the Inkorg underlag booked without a bank row or as an
 *                     utlägg: the reading's seller when present, never the
 *                     claimant, and the gross;
 *   null              never matched (the reason beside each).
 *
 * A Record over every source type: a new one does not compile until someone
 * decides whether a block holds it.
 */
export type BookingReviewSource = 'bank_rows' | 'supplier_invoice' | 'inbox_item'

export const BOOKING_REVIEW_SOURCES: Readonly<Record<JournalEntrySourceType, BookingReviewSource | null>> = {
  bank_transaction: 'bank_rows',
  manual: 'bank_rows',
  supplier_invoice_registered: 'supplier_invoice',
  supplier_invoice_cash_payment: 'supplier_invoice',
  inbox_item: 'inbox_item',
  // The payment of a registered invoice settles a purchase judged when it was
  // registered: 2440 against the bank, no VAT. Attest governs paying it, and
  // match_batch_allocate posts it in SQL, where no person's review can stamp.
  supplier_invoice_paid: null,
  // The invoice's own registration lines on the other side, judged with it.
  supplier_credit_note: null,
  // The company's own issued documents and their payments: the booking follows
  // the invoice 1:1, and refusing it leaves an issued invoice outside the books.
  invoice_created: null,
  invoice_paid: null,
  invoice_cash_payment: null,
  credit_note: null,
  reminder_fee: null,
  rot_rut_payout: null,
  rot_rut_reclaim: null,
  rot_rut_reclassification: null,
  customer_loss: null,
  counterparty_setoff: null,
  collection_settlement: null,
  stripe_payout: null,
  webshop_order: null,
  pos_daily_sales: null,
  // A card expense from a spend platform: approved and coded at the provider,
  // booked by a person from Kortköp with its receipts. No bank row books it
  // and no Inkorg reading names its seller.
  spend_item: null,
  // An utlägg is judged on its cost lines and gross. Its seller comes from the
  // Inkorg reading when there is one; the claimant is never a counterparty.
  expense_claim: 'inbox_item',
  supplier_invoice_privately_paid: null,
  // Repaying a booked claim, directly or on a payslip, moves only the liability
  // and the bank. The purchase was judged when the claim was registered.
  expense_payout: null,
  salary_payment: null,
  // Corrections and history: storno and rättelse (BFL 5 kap 5 §), imports.
  storno: null,
  correction: null,
  import: null,
  opening_balance: null,
  // Period and year-end mechanics, posted from what is already booked.
  year_end: null,
  result_appropriation: null,
  vat_settlement: null,
  currency_revaluation: null,
  accrual: null,
  system: null,
  tax_account: null,
}

/** A matched rule as a decision records it. */
export interface MatchedBookingReviewRule {
  id: string
  rule_id: string
  version: number
}

/** One bank row a booking books. */
export interface BookingReviewBankRow {
  /** grantCounterpartyKey of the row; '' when its text names no one. */
  counterpartyKey: string
  /** What the row moves, in SEK, without sign. */
  amountSek: number
}

/** What a booking is judged on. */
export interface BookingReviewFacts {
  /** Every account the verifikat touches (or, for a suggestion, the accounts it names). */
  accounts: readonly string[]
  /** The bank rows it books. */
  bankRows: readonly BookingReviewBankRow[]
  /**
   * The VAT its lines carry. Null when not known yet (a suggestion without a
   * VAT treatment): any VAT criterion then counts as met, so it asks.
   */
  vatClasses: readonly BookingReviewVatClass[] | null
}

// ── Counterparty identity ────────────────────────────────────────────

/**
 * Payment processors and rails whose name every purchase through them
 * shares: no identity of their own. Mirror of the rails list in
 * public.grant_counterparty_key (migration 20261017100200).
 */
const RAILS: ReadonlySet<string> = new Set([
  'paypal', 'klarna', 'izettle', 'zettle', 'iz', 'sq', 'sp', 'sumup', 'google', 'stripe', 'payu', 'mollie',
  'swish', 'bankgiro', 'plusgiro', 'autogiro', 'kortköp', 'kort', 'internet bet', 'överföring', 'insättning',
])

/**
 * The counterparty identity of a bank row, as grants key it (mirror of
 * public.grant_counterparty_key): the merchant name, else the bank's
 * original description, else the description, normalized. '' when the text
 * names no one, is shorter than two characters, or is only a payment rail.
 */
export function grantCounterpartyKey(
  merchantName: string | null | undefined,
  originalDescription: string | null | undefined,
  description: string | null | undefined,
): string {
  const raw = merchantName || originalDescription || description
  if (!raw || !namesCounterparty(raw)) return ''
  const key = normalizeCounterpartyName(raw)
  if (!key || key.length < 2 || RAILS.has(key) || !/\p{L}/u.test(key)) return ''
  return key
}

/** A bank row as a rule judges it. */
export function bankRowFacts(tx: {
  merchant_name?: string | null
  original_description?: string | null
  description?: string | null
  amount: number
  amount_sek?: number | null
}): BookingReviewBankRow {
  return {
    counterpartyKey: grantCounterpartyKey(tx.merchant_name, tx.original_description, tx.description),
    amountSek: Math.abs(Number(tx.amount_sek ?? tx.amount) || 0),
  }
}

// ── VAT ──────────────────────────────────────────────────────────────

interface LineAmounts {
  account_number: string
  debit_amount?: number | string | null
  credit_amount?: number | string | null
}

/**
 * The VAT a verifikat's lines carry, as rules name it (mirror of
 * public.booking_review_vat_classes; the accounts' roles are
 * bookingVatRole in lib/vat/moms-box-mapping.ts):
 *   reverse_charge  a line on an omvänd-betalningsskyldighet or import account;
 *   standard_25 /   a line on another utgående moms account of the rate
 *   reduced_12 /    (261x, 262x, 263x), or ingående moms (264x but 2645 and
 *   reduced_6       2647) at the share of the gross that rate gives, within
 *                   half a percentage point: 25 % of the net is 20 % of the
 *                   gross, 12 % is 10.71 %, 6 % is 5.66 %. Any other share
 *                   (a partly deductible car lease, representation over the
 *                   cap, mixed rates) carries all three, so a block on a
 *                   rate never misses it;
 *   none            no VAT line.
 * The gross is the larger side of the lines off 26xx, the bank leg on a bank
 * booking, so a refund reads as its purchase does. Sorted, distinct.
 */
export function vatClassesFromLines(lines: readonly LineAmounts[]): BookingReviewVatClass[] {
  const classes = new Set<BookingReviewVatClass>()
  let input = 0
  let debit = 0
  let credit = 0
  for (const line of lines) {
    const role = bookingVatRole(line.account_number)
    const d = Number(line.debit_amount) || 0
    const c = Number(line.credit_amount) || 0
    if (role === 'input') input += d - c
    else if (role === 'not_vat') {
      debit += d
      credit += c
    } else if (role !== 'other_vat') classes.add(role)
  }
  // In öre, as the database sums numeric: lines that net to zero carry no input VAT.
  const vat = roundOre(input)
  if (vat !== 0) {
    const gross = Math.max(roundOre(debit), roundOre(credit))
    const share = gross > 0 ? Math.abs(vat) / gross : null
    const near = (rate: number) => share !== null && Math.abs(share - rate / (1 + rate)) <= 0.005
    if (near(0.25)) classes.add('standard_25')
    else if (near(0.12)) classes.add('reduced_12')
    else if (near(0.06)) classes.add('reduced_6')
    else for (const c of ['standard_25', 'reduced_12', 'reduced_6'] as const) classes.add(c)
  }
  if (classes.size === 0) return ['none']
  return [...classes].sort()
}

/**
 * The VAT a suggestion's treatment books, before there are lines: null when
 * it names none, so a VAT criterion counts as met and the suggestion asks.
 */
export function vatClassesOfTreatment(treatment: VatTreatment | string | null | undefined): BookingReviewVatClass[] | null {
  switch (treatment) {
    case 'standard_25':
    case 'reduced_12':
    case 'reduced_6':
      return [treatment]
    case 'reverse_charge':
    case 'reverse_charge_domestic':
      return ['reverse_charge']
    case 'export':
    case 'exempt':
      return ['none']
    default:
      return null
  }
}

/** The facts of a verifikat's lines and the bank rows it books. */
export function factsFromLines(lines: readonly LineAmounts[], bankRows: readonly BookingReviewBankRow[]): BookingReviewFacts {
  return {
    accounts: [...new Set(lines.map((l) => l.account_number))],
    bankRows,
    vatClasses: vatClassesFromLines(lines),
  }
}

// ── Matching ─────────────────────────────────────────────────────────

/** Whether the rule matches the booking: every criterion it sets. */
export function ruleMatches(rule: BookingReviewRule, facts: BookingReviewFacts): boolean {
  if (rule.revoked_at) return false
  if (rule.accounts && rule.accounts.length > 0 && !rule.accounts.some((a) => facts.accounts.includes(a))) return false
  if (rule.vat_treatment && facts.vatClasses && !facts.vatClasses.includes(rule.vat_treatment)) return false
  const key = rule.counterparty_key
  const from = rule.amount_from_sek === null || rule.amount_from_sek === undefined ? null : Number(rule.amount_from_sek)
  if (key === null && from === null) return true
  return facts.bankRows.some(
    (row) => (key === null || row.counterpartyKey === key) && (from === null || row.amountSek >= from),
  )
}

/** The active rules that match the booking, as a decision records them. */
export function matchBookingReviewRules(
  rules: readonly BookingReviewRule[],
  facts: BookingReviewFacts,
): MatchedBookingReviewRule[] {
  return rules
    .filter((rule) => ruleMatches(rule, facts))
    .map((rule) => ({ id: rule.id, rule_id: rule.rule_id, version: rule.version }))
}
