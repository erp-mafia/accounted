/**
 * Hard blocks (accounted#130, step 2): "never book X without me".
 *
 * A booking review rule (booking_review_rules, migration 20261031150000)
 * names what a person always reviews before it is booked: accounts, a
 * counterparty, an amount from, a VAT treatment, or any mix. A booking of a
 * bank row matches when every criterion the rule sets matches:
 *
 *   accounts         the verifikat touches any of them;
 *   counterparty     a bank row it books has this counterparty identity
 *                    (grantCounterpartyKey, the identity grants are keyed by);
 *   amount from      that same bank row moves at least this much, in SEK;
 *   VAT treatment    the verifikat's VAT lines carry it (vatClassesFromLines).
 *
 * The counterparty and the amount are judged on one bank row together, so a
 * samlingsverifikat matches when one of its rows does.
 *
 * Pure and isomorphic. Mirrored in SQL by booking_review_entry_matches and
 * booking_review_vat_classes, which commit_journal_entry asks last: every
 * door asks here first, so a refusal there is the last line, not the first.
 * tests/pg/booking-review-rules.pg.test.ts pins the two together.
 */
import { namesCounterparty, normalizeCounterpartyName } from '@/lib/bookkeeping/counterparty-templates'
import type { VatTreatment } from '@/types'
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
