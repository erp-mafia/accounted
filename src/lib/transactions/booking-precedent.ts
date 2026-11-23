import type { SupabaseClient } from '@supabase/supabase-js'
import {
  calculateConfidence,
  namesCounterparty,
  normalizeCounterpartyName,
  verifikatTemplateShape,
} from '@/lib/bookkeeping/counterparty-templates'
import { BANK_LEG_PLACEHOLDER, isCashLedger } from '@/lib/bookkeeping/bank-leg'
import { getAccountName } from '@/lib/bookkeeping/client-account-names'
import { accountProposal, categoryForAccount, type BookingProposal } from '@/lib/bookkeeping/proposal'
import { isSkatteverketPayment } from '@/lib/bookkeeping/skatteverket-payment'
import { vatAccountNature, type BankRowNature } from '@/lib/bookkeeping/vat-entries'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'
import { roundOre } from '@/lib/money'
import { businessAccountOfLines, carriesMomsLine } from '@/lib/suggestion-log/business-account'
import type { EntityType, Transaction, TransactionCategory, VatTreatment } from '@/types'

/**
 * "As last time": how the company last booked a bank row of the same
 * counterparty, read from the posted verifikat, as a proposal for a row no
 * counterparty rule proposes for (proposeForTransactions, ./propose.ts, for
 * a company in BOOKING_PRECEDENT_COMPANY_IDS).
 *
 * Which earlier rows count is the database's answer (booking_precedents,
 * migration 20261123193100): the same counterparty key, booked by a posted
 * verifikat that is not a storno, dated within the window. What such a
 * booking says is read here, by the definitions the rest of the bank side
 * reads a verifikat by:
 *
 *   - the account is businessAccountOfLines, the rule the decision log reads
 *     a final booking by: the one account that is neither a cash ledger, moms
 *     nor the row's own settlement ledger. A booking with none or several is
 *     passed over for the next most recent one;
 *   - the moms is none when the verifikat carries no moms line, otherwise
 *     what verifikatTemplateShape reads off it, the reading the counterparty
 *     templates are learned by: a rate, or reverse charge. A booking whose
 *     moms that reading cannot state as one treatment on the same account is
 *     passed over.
 *
 * Only earlier rows where the money moved the same way as on the row count:
 * money in from a counterparty that was only ever paid is not "as last time".
 *
 * The proposal is one account against the bank with that moms. It is no
 * rule: source 'precedent' never books without a review
 * (./direct-booking.ts), however many earlier bookings agree.
 */

/** How far back an earlier booking counts, in days of the bank row's date. */
export const PRECEDENT_WINDOW_DAYS = 365

/**
 * The earlier bookings read per counterparty, newest first. The count a
 * proposal carries (seen_count) is taken among these, so it never exceeds it.
 */
export const PRECEDENT_BOOKINGS_READ = 20

export interface PrecedentLine {
  account: string
  debit: number
  credit: number
}

/** One earlier booked bank row of the counterparty, as booking_precedents answers it. */
export interface PrecedentBooking {
  transaction_id: string
  date: string
  amount: number
  journal_entry_id: string
  /** The ledger account of the earlier row's own cash account, when it had one. */
  settlement_ledger: string | null
  lines: PrecedentLine[]
}

interface PrecedentAnswer {
  names?: Record<string, string> | null
  bookings?: Record<string, PrecedentBooking[]> | null
}

type RowText = Pick<Transaction, 'amount' | 'merchant_name' | 'original_description' | 'description'> &
  Partial<Pick<Transaction, 'counterparty_account'>>

/**
 * The text a row's counterparty is read from, as the counterparty templates
 * read it (findCounterpartyTemplatesBatch): the merchant name, else the
 * bank's original description, else the description. Null when the row has
 * no precedent to look for: a text that names no one, a key shorter than two
 * characters, or a payment to Skatteverket, which books on the skattekonto by
 * rule and never by habit.
 */
export function precedentText(tx: RowText): string | null {
  const text = tx.merchant_name || tx.original_description || tx.description
  if (!text || !namesCounterparty(text)) return null
  if (normalizeCounterpartyName(text).length < 2) return null
  if (isSkatteverketPayment(tx)) return null
  return text
}

/**
 * The earlier bookings of each row's counterparty, newest first, never the
 * row itself: one database call for all the rows. A row without a text to
 * look for, or whose counterparty was never booked in the window, has no
 * entry.
 */
export async function loadBookingPrecedents(
  supabase: SupabaseClient,
  companyId: string,
  transactions: ReadonlyArray<Pick<Transaction, 'id'> & RowText>,
  today: string = todayIsoStockholm(),
): Promise<Map<string, PrecedentBooking[]>> {
  const out = new Map<string, PrecedentBooking[]>()
  const texts = new Map<string, string>()
  for (const tx of transactions) {
    const text = precedentText(tx)
    if (text) texts.set(tx.id, text)
  }
  if (texts.size === 0) return out

  const { data, error } = await supabase.rpc('booking_precedents', {
    p_company_id: companyId,
    p_names: [...new Set(texts.values())],
    p_from_date: addDaysIso(today, -PRECEDENT_WINDOW_DAYS),
    p_per_counterparty: PRECEDENT_BOOKINGS_READ,
  })
  if (error) throw new Error(`booking precedents read failed: ${error.message}`)

  const answer = (data ?? {}) as PrecedentAnswer
  for (const [id, text] of texts) {
    const key = answer.names?.[text]
    const bookings = key ? (answer.bookings?.[key] ?? []).filter((b) => b.transaction_id !== id) : []
    if (bookings.length > 0) out.set(id, bookings)
  }
  return out
}

/** What one earlier booking booked: the account, its moms, and what kind of booking the moms says it was. */
export interface BookedAs {
  account: string
  vat_treatment: VatTreatment
  /** A purchase's or a sale's moms; null when the booking carried none. */
  nature: BankRowNature | null
}

const READABLE_TREATMENTS: ReadonlySet<string> = new Set(['standard_25', 'reduced_12', 'reduced_6', 'reverse_charge'])

/**
 * The account and moms of one earlier booking, or null when its lines do not
 * say one of each (see the file header).
 */
export function bookedAs(booking: Pick<PrecedentBooking, 'lines' | 'settlement_ledger'>): BookedAs | null {
  const ledgers = booking.settlement_ledger ? [booking.settlement_ledger] : []
  const account = businessAccountOfLines(booking.lines, ledgers)
  if (!account) return null
  if (!carriesMomsLine(booking.lines)) {
    return { account, vat_treatment: 'exempt', nature: null }
  }

  // A row on a card or another non-19xx ledger of its own is read with the
  // bank placeholder on its bank leg, as the bank-link learner reads it.
  const shape = verifikatTemplateShape(
    booking.lines.map((line) => ({
      account: ledgers.includes(line.account) && !isCashLedger(line.account) ? BANK_LEG_PLACEHOLDER : line.account,
      amount: roundOre((Number(line.debit) || 0) - (Number(line.credit) || 0)),
    })),
  )
  if (!shape || shape.linePattern) return null
  if (shape.debitAccount !== account && shape.creditAccount !== account) return null
  if (!shape.vatTreatment || !READABLE_TREATMENTS.has(shape.vatTreatment)) return null
  return { account, vat_treatment: shape.vatTreatment as VatTreatment, nature: vatAccountNature(shape.vatAccount) }
}

/**
 * The proposal for a row from the earlier bookings of its counterparty
 * (newest first, as loadBookingPrecedents answers them), or null when none
 * of them says how to book it. The newest readable booking where the money
 * moved the same way decides; seen_count is how many of the readable ones
 * booked the same account with the same moms, itself included.
 */
export function precedentProposal(
  tx: Pick<Transaction, 'id' | 'amount'>,
  bookings: readonly PrecedentBooking[],
  entityType?: EntityType,
): BookingProposal | null {
  const sameWay = bookings.filter(
    (b) => b.transaction_id !== tx.id && Math.sign(Number(b.amount)) === Math.sign(tx.amount) && tx.amount !== 0,
  )
  const read = sameWay.map(bookedAs).filter((b): b is BookedAs => b !== null)
  // Reverse charge is a purchase's: on money in the engine books no set, so
  // the row would not be booked as it was.
  const last = read.find((b) => !(b.vat_treatment === 'reverse_charge' && tx.amount > 0))
  if (!last) return null

  const agree = read.filter((b) => b.account === last.account && b.vat_treatment === last.vat_treatment).length
  const times = `${agree} ${agree === 1 ? 'gång' : 'gånger'}`
  return {
    ...accountProposal({
      id: `precedent:${last.account}`,
      source: 'precedent',
      account: last.account,
      label: getAccountName(last.account),
      category: precedentCategory(last, tx.amount, entityType),
      vat_treatment: last.vat_treatment,
      amount: tx.amount,
      confidence: calculateConfidence(agree),
      description: `Som förra gången: bokförd så ${times} tidigare`,
    }),
    requires_review: true,
    seen_count: agree,
  }
}

/**
 * The category the booking is made under: it decides which side the account
 * and its moms take (lib/bookkeeping/category-mapping.ts). The moms says
 * whether the earlier booking was a purchase or a sale; without moms the
 * row's own direction does, which books the same lines either way. The
 * account's own category is kept when it is of that kind.
 */
function precedentCategory(last: BookedAs, amount: number, entityType?: EntityType): TransactionCategory {
  const nature: BankRowNature = last.nature ?? (amount < 0 ? 'expense' : 'income')
  const own = categoryForAccount(last.account, entityType)
  if (own.startsWith(`${nature}_`)) return own
  return nature === 'expense' ? 'expense_other' : 'income_other'
}
