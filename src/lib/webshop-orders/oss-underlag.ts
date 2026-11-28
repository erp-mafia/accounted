import { sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import { chunk as chunks } from '@/lib/utils'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEntriesWithAccountLines, fetchLinesByEntryIds } from '@/lib/bookkeeping/entry-lines'
import { netVat } from '@/lib/bookkeeping/gross-split'
import { fetchEcbEuroRate, type EcbRateLookup } from '@/lib/currency/ecb'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { roundOre } from '@/lib/money'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { isVatBoxAccount } from '@/lib/vat/account-vat-box'
import { EU_COUNTRIES, isOtherEuCountry } from '@/lib/vat/eu-countries'
import { OSS_ALL_EU_COUNTRIES, suggestOssAccount, type OssAccountKind } from '@/lib/vat/oss-accounts'
import type { WebshopCountryAccountRule, WebshopOrder } from '@/types'
import { OSS_VAT_ACCOUNT, SWEDISH_RULE_RATES, isOssRule, sameVatRate } from './country-routing'
import { readReleasedWebshopBookings } from './released-booking'

/**
 * Underlag for the OSS declaration (unionsordningen): per quarter, the sales
 * to consumers in other EU countries by country and VAT rate, in euro, plus
 * the corrections of earlier quarters, from what is booked on the OSS
 * accounts.
 *
 * The ledger decides WHICH verifikat count and WHEN: every verifikat dated in
 * the quarter with a line on an OSS account. Its country and rate come from
 * one of two places:
 *
 *   - The webshop order it books. The "Vi redovisar OSS" country rule books
 *     every EU country on one shared pair (3106/2670), so the ledger cannot
 *     say which country a krona belongs to; the order row can (Shopify's
 *     destination country and VAT split).
 *   - Its accounts, for a verifikat that books no order (an invoice, a sale
 *     booked by hand, an imported voucher), when the company keeps one sales
 *     account per country and rate and the account names both
 *     (lib/vat/oss-accounts.ts). The sale is placed by its sales account. The
 *     VAT follows the sales it is booked with: on the VAT account of a
 *     country it goes to that country's sales, and between several sales it
 *     is shared by what their rates make of them. Only the OSS output VAT
 *     account, and an account the country rules name for several countries,
 *     is shared.
 *
 * A verifikat with neither gets no row: its country and rate are not in the
 * ledger, and guessing them from the totals would put a figure in a
 * declaration. It is listed with a warning, and the quarter is then never
 * answered as a nil return.
 *
 * What the law asks (Skatteverket, "Deklarera och betala moms i One Stop
 * Shop"; VAT Directive art. 369h; the Commission's OSS guide, part 3):
 *   - per country: the consideration without VAT and the VAT, per rate;
 *   - in euro, converted at the ECB rate for the last day of the quarter (the
 *     next day of publication when the ECB publishes none that day);
 *   - the VAT with two decimals, never rounded to whole euro;
 *   - a refund, credit or price reduction in the quarter it is booked, as a
 *     correction of the quarter the sale was declared in: country, quarter
 *     and VAT amount only.
 * Which ECB rate converts a correction neither source says. This uses the
 * rate of the quarter being corrected, so that a full refund takes back
 * exactly what was declared.
 *
 * A verifikat placed by its accounts corrects an earlier quarter when it is
 * the storno or the rättelse of a verifikat dated in that quarter: the link
 * names the quarter. A refund booked as a verifikat of its own has no link.
 * It is taken off the quarter it is booked in and listed (refund_vouchers),
 * so the reader can declare it as a correction when it belongs to an earlier
 * quarter.
 */

export interface OssQuarterRef {
  year: number
  quarter: number
}

export interface OssUnderlagRow {
  country: string
  /** Percent, e.g. 19 or 25.5. */
  vat_rate: number
  /** Null while an ECB rate the row needs is missing. */
  net_eur: number | null
  vat_eur: number | null
  net_sek: number
  vat_sek: number
  /** Order and refund rows behind the figure. */
  order_count: number
  /** Verifikat behind the figure that book no order and were placed by their accounts. */
  voucher_count: number
  /**
   * The VAT those verifikat book is not the row's rate of the sales they
   * book: a wrong rate on the account, a wrong VAT amount, or VAT booked on
   * an account that is not an OSS VAT account. False for a row of orders only.
   */
  rate_mismatch: boolean
}

export interface OssUnderlagCorrection {
  country: string
  /** The quarter the corrected sale was declared in. */
  period: OssQuarterRef & { label: string }
  /** Negative for a refund. Null while an ECB rate is missing. */
  vat_eur: number | null
  vat_sek: number
  refund_count: number
  /** Stornos and rättelser of that quarter's verifikat, placed by their accounts. */
  voucher_count: number
}

export interface OssEuroRate {
  currency: string
  /** The day the rate is for: the last day of the quarter. */
  for_date: string
  /** Units of the currency per euro; null when the ECB has none (yet) or could not be reached. */
  rate: number | null
  /** The ECB publication day used (for_date, or its next day of publication). */
  rate_date: string | null
  unavailable: boolean
}

/** A verifikat on an OSS account, with what it books there. */
export interface OssUnaccountedVoucher {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number
  entry_date: string
  description: string
  /** Credit minus debit on the OSS revenue accounts. */
  net_sek: number
  /** Credit minus debit on the OSS VAT accounts. */
  vat_sek: number
}

/** An OSS account and the country it names, for the reader who sets it. */
export interface OssAccount {
  account_number: string
  account_name: string
  kind: OssAccountKind
  /** The country the account names, or null. A VAT account may name 'EU': every EU country. */
  country: string | null
  /** Percent. Sales accounts only. */
  vat_rate: number | null
  /** What the account's name states, for an account that names no country yet. */
  suggested_country: string | null
  suggested_vat_rate: number | null
  /** A verifikat of the quarter is outside the underlag because this account names no country. */
  blocks_vouchers: boolean
}

export interface OssUnderlagWarning extends OperationWarning {
  order_numbers: string[]
}

export interface OssUnderlag {
  period: OssQuarterRef & { start: string; end: string; label: string; deadline: string }
  rows: OssUnderlagRow[]
  corrections: OssUnderlagCorrection[]
  totals: {
    net_eur: number | null
    vat_eur: number | null
    corrections_vat_eur: number | null
    net_sek: number
    vat_sek: number
    corrections_vat_sek: number
  }
  rates: OssEuroRate[]
  /** The quarter's movement on the OSS VAT accounts, the figure the underlag reconciles to. */
  ledger_vat_sek: number
  /** Verifikat on OSS accounts in no row: no order behind them and no country on their accounts. */
  unaccounted: OssUnaccountedVoucher[]
  /**
   * Verifikat placed by their accounts that take sales off the quarter: a
   * refund booked as a verifikat of its own. They are in the rows. One that
   * belongs to an earlier quarter is a correction of that quarter instead.
   */
  refund_vouchers: OssUnaccountedVoucher[]
  /**
   * The accounts that name a country, the sales accounts a verifikat in
   * `unaccounted` waits for, and the VAT accounts whose name states a country.
   */
  accounts: OssAccount[]
  warnings: OssUnderlagWarning[]
  /**
   * Nothing to declare: Skatteverket still wants a declaration (a nil
   * return). True only when nothing says otherwise: no row, no correction,
   * no entry in `unaccounted`, no order missing (`warnings`) and no VAT
   * movement on the OSS accounts. Empty rows with this false is an underlag
   * with a gap, not a quarter without sales.
   */
  nil_return: boolean
}

// ---------------------------------------------------------------------------
// Quarters
// ---------------------------------------------------------------------------

function isoDay(year: number, monthIndex: number, day: number): string {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10)
}

/** First and last day of a calendar quarter. */
export function ossQuarterBounds(year: number, quarter: number): { start: string; end: string } {
  return { start: isoDay(year, (quarter - 1) * 3, 1), end: isoDay(year, quarter * 3, 0) }
}

/** The calendar quarter a date falls in. */
export function ossQuarterOf(date: string): OssQuarterRef {
  return { year: Number(date.slice(0, 4)), quarter: Math.ceil(Number(date.slice(5, 7)) / 3) }
}

/**
 * The last day of the month after the quarter. An EU deadline: it does not
 * move to the next banking day (deadline-config.ts, oss_quarterly).
 */
export function ossDeadline(year: number, quarter: number): string {
  return isoDay(year, quarter * 3 + 1, 0)
}

function quarterLabel(ref: OssQuarterRef): string {
  return `Q${ref.quarter} ${ref.year}`
}

function quarterKey(ref: OssQuarterRef): string {
  return `${ref.year}-Q${ref.quarter}`
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A verifikat dated in the quarter with a line on an OSS account, with just those lines. */
export interface OssEntry {
  id: string
  voucher_series: string | null
  voucher_number: number
  entry_date: string
  description: string
  status: string
  reverses_id: string | null
  correction_of_id: string | null
  lines: Array<{ account_number: string; debit_amount: number | string | null; credit_amount: number | string | null }>
}

export type OssOrder = Pick<
  WebshopOrder,
  | 'id'
  | 'platform'
  | 'row_type'
  | 'parent_order_id'
  | 'order_number'
  | 'customer_country'
  | 'currency'
  | 'exchange_rate'
  | 'vat_breakdown'
  | 'journal_entry_id'
  | 'manually_booked_journal_entry_id'
  | 'manually_booked_at'
  | 'invoice_id'
  | 'legacy_transaction_id'
  | 'is_paid'
  | 'paid_date'
  | 'order_date'
>

/** The country an OSS account names, and the rate when it is a sales account. */
export interface OssAccountCountry {
  country: string
  vat_rate: number | null
}

export interface OssClassifyInput {
  quarter: OssQuarterRef
  /** Revenue accounts of OSS sales: VAT code 'oss', or named by an OSS country rule. */
  revenueAccounts: ReadonlySet<string>
  /** VAT accounts of OSS sales: the OSS output VAT account and those OSS country rules name. */
  vatAccounts: ReadonlySet<string>
  entries: readonly OssEntry[]
  /** The orders whose verifikat (booked or marked as booked) is one of `entries`. */
  orders: readonly OssOrder[]
  /** For each refund's parent order not booked in this quarter: the date of its OSS verifikat, or null. */
  parentBookingDates: ReadonlyMap<string, string | null>
  /** The country each OSS account names. Accounts that name none are absent. */
  accountCountries: ReadonlyMap<string, OssAccountCountry>
  /**
   * The date of each verifikat that a storno or rättelse in `entries` points
   * at and that is not itself in `entries`.
   */
  linkedEntryDates: ReadonlyMap<string, string>
  /**
   * Shopify rows to another EU country paid (or ordered) in the quarter,
   * booked or not, for the warnings about orders missing from the underlag.
   */
  quarterOrders: readonly OssOrder[]
  /**
   * The verifikat of `quarterOrders` that a storno released them from
   * (isWebshopBookingReleased): such an order is unbooked unless the
   * verifikat still books it in this quarter.
   */
  releasedEntryIds?: ReadonlySet<string>
}

/** Sums in one currency, before the conversion to euro. */
interface CurrencyAmounts {
  currency: string
  net: number
  vat: number
  net_sek: number
  vat_sek: number
}

interface Aggregate {
  byCurrency: Map<string, CurrencyAmounts>
  /** The order and refund rows behind the figure. */
  orderIds: Set<string>
  /** The verifikat placed by their accounts behind the figure. */
  voucherIds: Set<string>
}

/** What the verifikat placed by their accounts book in a row, for the rate check. */
interface LedgerSums {
  net_sek: number
  vat_sek: number
  /** The sales lines behind the sums. */
  lines: number
}

export interface OssClassification {
  /** country|rate → sums per currency. */
  rows: Map<string, Aggregate & { country: string; vat_rate: number; ledger: LedgerSums }>
  /** country|quarter → sums per currency. */
  corrections: Map<string, Aggregate & { country: string; period: OssQuarterRef }>
  unaccounted: OssUnaccountedVoucher[]
  refundVouchers: OssUnaccountedVoucher[]
  /** The sales accounts on verifikat in `unaccounted` that name no country. */
  accountsWithoutCountry: string[]
  ledgerVatSek: number
  warnings: OssUnderlagWarning[]
}

// ---------------------------------------------------------------------------
// Advisories
// ---------------------------------------------------------------------------

const WARNING_TEXT: Record<string, { sv: string; en: string }> = {
  unbooked_orders: {
    sv: 'Ordrar till andra EU-länder som betalades under kvartalet är inte bokförda än och finns inte med i underlaget. Bokför dem på Ordrar först.',
    en: 'Orders to other EU countries paid during the quarter are not booked yet and are not in the report. Book them on Orders first.',
  },
  foreign_vat_not_oss: {
    sv: 'Ordrar med utländsk moms är bokförda utan OSS-konton och finns inte med i underlaget. Välj OSS-konton under Konton per land och rätta verifikaten.',
    en: 'Orders with foreign VAT are booked without OSS accounts and are not in the report. Choose OSS accounts under Accounts per country and correct the vouchers.',
  },
  orders_not_placeable: {
    sv: 'Ordrar bokförda på OSS-konton saknar ett annat EU-land eller växelkurs och finns inte med i underlaget.',
    en: 'Orders booked on OSS accounts have no other EU country or exchange rate and are not in the report.',
  },
  refund_parent_not_oss: {
    sv: 'Återbetalningar vars order inte är bokförd som OSS-försäljning finns inte med i underlaget. Redovisa dem som rättelse för det kvartal ordern deklarerades i.',
    en: 'Refunds whose order is not booked as an OSS sale are not in the report. Declare them as a correction of the quarter the order was declared in.',
  },
  vouchers_without_order: {
    sv: 'Verifikat på OSS-konton i kvartalet har ingen order bakom sig, och kontona anger inte vilket land och vilken momssats de gäller, så de finns inte med i beloppen. Bokför du försäljningen på ett konto per land och momssats anger du landet och satsen på kontot under Konton per land, så räknas verifikaten med. Annars lägger du till försäljningen, eller återbetalningen, i deklarationen själv: land, momssats och belopp tar du ur ditt eget försäljningsunderlag. Försäljning räknas om till euro med ECB:s kurs för kvartalets sista dag.',
    en: 'Vouchers on OSS accounts in the quarter have no order behind them, and the accounts do not say which country and VAT rate they are for, so they are left out of the amounts. If you book the sales on one account per country and VAT rate, set the country and the rate on the account under Accounts per country and the vouchers are counted. Otherwise add the sale, or the refund, to the return yourself: take the country, VAT rate and amounts from your own sales records. Sales are converted to euro at the ECB rate for the last day of the quarter.',
  },
  refund_vouchers_netted: {
    sv: 'Verifikat som minskar OSS-försäljningen är avräknade från kvartalets försäljning i samma land. Gäller ett av dem en försäljning i ett tidigare kvartal ska det i stället redovisas som rättelse av det kvartalet. Ett tidigare kvartals verifikat som rättas med storno redovisas redan som rättelse.',
    en: 'Vouchers that reduce the OSS sales are taken off the quarter\'s sales in the same country. If one of them is for a sale in an earlier quarter, declare it as a correction of that quarter instead. A voucher of an earlier quarter corrected by reversal is already declared as a correction.',
  },
  vat_rate_mismatch: {
    sv: 'Momsen stämmer inte med momssatsen på de markerade raderna. Kontrollera verifikaten på landets konton: fel momssats på kontot, fel momsbelopp, eller moms bokförd på ett konto som inte är angivet som OSS-momskonto.',
    en: 'The VAT does not match the VAT rate on the marked rows. Check the vouchers on that country\'s accounts: a wrong VAT rate on the account, a wrong VAT amount, or VAT booked on an account that is not set as an OSS VAT account.',
  },
  rate_unavailable: {
    sv: 'ECB:s eurokurs för sista dagen i kvartalet finns inte än eller kunde inte hämtas, så eurobeloppen saknas. Beloppen i kronor stämmer.',
    en: 'The ECB euro rate for the last day of the quarter is not published yet or could not be fetched, so the euro amounts are missing. The krona amounts are right.',
  },
}

function warning(code: keyof typeof WARNING_TEXT, orderNumbers: string[] = []): OssUnderlagWarning {
  return {
    code,
    message_sv: WARNING_TEXT[code].sv,
    message_en: WARNING_TEXT[code].en,
    order_numbers: Array.from(new Set(orderNumbers)).sort(),
  }
}

// ---------------------------------------------------------------------------
// Classification (pure)
// ---------------------------------------------------------------------------

function amount(value: number | string | null): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function linkedEntryId(order: Pick<OssOrder, 'journal_entry_id' | 'manually_booked_journal_entry_id'>): string | null {
  return order.journal_entry_id ?? order.manually_booked_journal_entry_id ?? null
}

function destinationOf(order: OssOrder): string | null {
  const country = order.customer_country?.trim().toUpperCase()
  // Sweden is the identification state: a sale to a Swedish consumer is a
  // domestic sale, never an OSS one.
  if (!country || !isOtherEuCountry(country)) return null
  return country
}

/** Rates are percentages with at most two decimals (25.5). */
function rateKey(rate: number): number {
  return roundOre(rate)
}

function addAmounts(
  aggregate: Aggregate,
  source: { orderId: string } | { voucherId: string },
  currency: string,
  sums: Omit<CurrencyAmounts, 'currency'>,
): void {
  const current = aggregate.byCurrency.get(currency) ?? { currency, net: 0, vat: 0, net_sek: 0, vat_sek: 0 }
  current.net += sums.net
  current.vat += sums.vat
  current.net_sek = roundOre(current.net_sek + sums.net_sek)
  current.vat_sek = roundOre(current.vat_sek + sums.vat_sek)
  aggregate.byCurrency.set(currency, current)
  if ('orderId' in source) aggregate.orderIds.add(source.orderId)
  else aggregate.voucherIds.add(source.voucherId)
}

/**
 * The buckets of an order that carry VAT, signed: a refund row takes the
 * amounts back. Platforms disagree on the sign of a refund's buckets
 * (Shopify stores them positive, Zettle negative), so the row type decides.
 * SEK per bucket the way the booking builds its lines
 * (booking-lines.ts: round(|amount| × rate)).
 */
function signedBuckets(order: OssOrder, sekRate: number) {
  const sign = order.row_type === 'refund' ? -1 : 1
  return order.vat_breakdown
    .filter((bucket) => bucket.rate > 0)
    .map((bucket) => ({
      rate: rateKey(bucket.rate),
      net: sign * Math.abs(bucket.net),
      vat: sign * Math.abs(bucket.tax),
      net_sek: sign * sekOfForeign(Math.abs(bucket.net), sekRate),
      vat_sek: sign * sekOfForeign(Math.abs(bucket.tax), sekRate),
    }))
}

function isSwedishRate(rate: number): boolean {
  return SWEDISH_RULE_RATES.some((swedish) => sameVatRate(swedish, rate))
}

/** The ledger is kept in kronor: what a verifikat books is converted from SEK. */
const LEDGER_CURRENCY = 'SEK'

/** What one verifikat books for one country and rate, by its accounts. */
interface LedgerPlacement {
  country: string
  vat_rate: number
  net_sek: number
  vat_sek: number
  /** Sales lines behind the net. */
  lines: number
}

type LedgerPlacementResult =
  | { ok: true; placements: LedgerPlacement[] }
  | { ok: false; accountsWithoutCountry: string[] }

/**
 * A VAT line shared between the sales it is booked with, in proportion to
 * what their rates make of them, to the öre and summing to the line exactly.
 * One sale takes it whole. The proportions are not rounded, so a sale of a
 * few öre still carries its part. Sales that sum to nothing give no
 * proportion: the last one takes the line, and the rate check marks its row.
 */
function shareVatLine(placements: LedgerPlacement[], lineSek: number): void {
  const weights = placements.map((placement) => Math.abs(placement.net_sek) * placement.vat_rate)
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let left = lineSek
  placements.forEach((placement, i) => {
    // The last one takes what is left, so the shares sum to the line.
    const last = i === placements.length - 1
    const share = last ? left : total === 0 ? 0 : roundOre((lineSek * weights[i]) / total)
    placement.vat_sek = roundOre(placement.vat_sek + share)
    left = roundOre(left - share)
  })
}

/**
 * The country and rate of what a verifikat books, read from its accounts.
 *
 * Every sales line must sit on an account that names a country and a rate;
 * one that does not leaves the whole verifikat unplaced, and the account is
 * named so the reader can set it. A VAT line on the VAT account of a country
 * goes to that country's sales in the verifikat; on a shared VAT account it
 * goes to all of them. A VAT line with no sale to go to (the payment of last
 * quarter's OSS VAT, VAT for a country the verifikat sells nothing to) leaves
 * the verifikat unplaced: what it is the ledger does not say.
 */
function placeByAccounts(
  entry: OssEntry,
  revenueAccounts: ReadonlySet<string>,
  vatAccounts: ReadonlySet<string>,
  accountCountries: ReadonlyMap<string, OssAccountCountry>,
): LedgerPlacementResult {
  const byKey = new Map<string, LedgerPlacement>()
  const without = new Set<string>()
  const vatLines: Array<{ country: string | null; sek: number }> = []

  for (const line of entry.lines) {
    const movement = amount(line.credit_amount) - amount(line.debit_amount)
    const named = accountCountries.get(line.account_number)
    if (vatAccounts.has(line.account_number)) {
      vatLines.push({ country: named && named.country !== OSS_ALL_EU_COUNTRIES ? named.country : null, sek: movement })
    } else if (revenueAccounts.has(line.account_number)) {
      if (!named || named.vat_rate === null) {
        without.add(line.account_number)
        continue
      }
      const rate = rateKey(named.vat_rate)
      const key = `${named.country}|${rate}`
      const placement = byKey.get(key) ?? { country: named.country, vat_rate: rate, net_sek: 0, vat_sek: 0, lines: 0 }
      placement.net_sek = roundOre(placement.net_sek + movement)
      placement.lines += 1
      byKey.set(key, placement)
    }
  }
  if (without.size > 0) return { ok: false, accountsWithoutCountry: Array.from(without) }

  const placements = Array.from(byKey.values())
  if (placements.length === 0) return { ok: false, accountsWithoutCountry: [] }
  for (const line of vatLines) {
    const sales = line.country ? placements.filter((placement) => placement.country === line.country) : placements
    if (sales.length === 0) return { ok: false, accountsWithoutCountry: [] }
    shareVatLine(sales, line.sek)
  }
  return { ok: true, placements }
}

/**
 * Half a krona per sales line. A VAT amount rounded to whole kronor passes;
 * a wrong rate does not, on any sale above some 50 kronor (one percentage
 * point of 50 kr is the half krona).
 */
const RATE_CHECK_SEK_PER_LINE = 0.5

/** Whether the VAT the placed verifikat book in a row is the row's rate of their sales. */
function ledgerRateMismatch(vatRate: number, ledger: LedgerSums): boolean {
  if (ledger.lines === 0) return false
  const expected = Math.sign(ledger.net_sek) * netVat(Math.abs(ledger.net_sek), vatRate / 100)
  return Math.abs(ledger.vat_sek - expected) > RATE_CHECK_SEK_PER_LINE * ledger.lines
}

function byVoucher(a: OssUnaccountedVoucher, b: OssUnaccountedVoucher): number {
  return (
    a.entry_date.localeCompare(b.entry_date)
    || (a.voucher_series ?? '').localeCompare(b.voucher_series ?? '')
    || a.voucher_number - b.voucher_number
  )
}

/**
 * Which orders the quarter's OSS verifikat book, and what is left over.
 *
 * - A verifikat and its storno in the same quarter cancel: neither counts.
 * - An order counts through the verifikat linked to it, or, when that one
 *   was reversed in the quarter, through the rättelse that replaced it.
 * - A verifikat reversed in a LATER quarter still counts here: in this
 *   quarter the books held it, and the storno is that later quarter's matter.
 * - A verifikat that books no order counts through its accounts when they
 *   name a country (placeByAccounts): in this quarter, or as a correction of
 *   the quarter of the verifikat it is the storno or rättelse of.
 * - Every other verifikat on an OSS account books nothing the underlag can
 *   place and is listed in `unaccounted` with its amounts, under the warning
 *   `vouchers_without_order`: what it is (a sale, a refund, the payment of
 *   last quarter's OSS VAT) the ledger does not say.
 */
export function classifyOssBookings(input: OssClassifyInput): OssClassification {
  const { quarter, revenueAccounts, vatAccounts, entries, orders, parentBookingDates } = input
  const bounds = ossQuarterBounds(quarter.year, quarter.quarter)
  const byId = new Map(entries.map((entry) => [entry.id, entry]))

  const cancelled = new Set<string>()
  for (const entry of entries) {
    if (entry.reverses_id && byId.has(entry.reverses_id)) {
      cancelled.add(entry.id)
      cancelled.add(entry.reverses_id)
    }
  }
  const correctionOf = new Map<string, OssEntry>()
  for (const entry of entries) {
    if (entry.correction_of_id) correctionOf.set(entry.correction_of_id, entry)
  }

  /** The verifikat that books an order in this quarter, following rättelser of cancelled ones. */
  const bookingEntryOf = (order: OssOrder): OssEntry | null => {
    let current = byId.get(linkedEntryId(order) ?? '') ?? null
    const seen = new Set<string>()
    while (current && cancelled.has(current.id) && !seen.has(current.id)) {
      seen.add(current.id)
      current = correctionOf.get(current.id) ?? null
    }
    return current && !cancelled.has(current.id) ? current : null
  }

  const booked = new Map<string, { order: OssOrder; entry: OssEntry }>()
  for (const order of orders) {
    const entry = bookingEntryOf(order)
    if (entry) booked.set(order.id, { order, entry })
  }

  const rows: OssClassification['rows'] = new Map()
  const corrections: OssClassification['corrections'] = new Map()
  const rowFor = (country: string, rate: number) => {
    const key = `${country}|${rate}`
    const row = rows.get(key) ?? {
      country,
      vat_rate: rate,
      byCurrency: new Map(),
      orderIds: new Set<string>(),
      voucherIds: new Set<string>(),
      ledger: { net_sek: 0, vat_sek: 0, lines: 0 },
    }
    rows.set(key, row)
    return row
  }
  const correctionFor = (country: string, period: OssQuarterRef) => {
    const key = `${country}|${quarterKey(period)}`
    const correction = corrections.get(key) ?? {
      country,
      period,
      byCurrency: new Map(),
      orderIds: new Set<string>(),
      voucherIds: new Set<string>(),
    }
    corrections.set(key, correction)
    return correction
  }
  const notPlaceable: string[] = []
  const refundsWithoutOssParent: string[] = []
  const accounted = new Set<string>()

  for (const { order, entry } of booked.values()) {
    accounted.add(entry.id)
    const country = destinationOf(order)
    const sekRate = order.exchange_rate
    if (!country || !sekRate) {
      notPlaceable.push(order.order_number)
      continue
    }
    const currency = order.currency.toUpperCase()

    // A refund of a sale declared in an earlier quarter corrects that
    // quarter; a refund of a sale in this quarter nets into it.
    let corrects: OssQuarterRef | null = null
    if (order.row_type === 'refund') {
      const parentId = order.parent_order_id
      if (!parentId || !booked.has(parentId)) {
        const parentDate = parentId ? parentBookingDates.get(parentId) ?? null : null
        if (!parentDate || parentDate >= bounds.start) {
          refundsWithoutOssParent.push(order.order_number)
          continue
        }
        corrects = ossQuarterOf(parentDate)
      }
    }

    for (const bucket of signedBuckets(order, sekRate)) {
      if (!corrects) addAmounts(rowFor(country, bucket.rate), { orderId: order.id }, currency, bucket)
      else addAmounts(correctionFor(country, corrects), { orderId: order.id }, currency, bucket)
    }
  }

  /** What a verifikat books on the OSS accounts, credit minus debit. */
  const voucherOf = (entry: OssEntry): OssUnaccountedVoucher => {
    let net = 0
    let vat = 0
    for (const line of entry.lines) {
      const movement = amount(line.credit_amount) - amount(line.debit_amount)
      if (vatAccounts.has(line.account_number)) vat += movement
      else if (revenueAccounts.has(line.account_number)) net += movement
    }
    return {
      journal_entry_id: entry.id,
      voucher_series: entry.voucher_series,
      voucher_number: entry.voucher_number,
      entry_date: entry.entry_date,
      description: entry.description,
      net_sek: roundOre(net),
      vat_sek: roundOre(vat),
    }
  }

  // A verifikat no order books is placed by the country its accounts name.
  const accountsWithoutCountry = new Set<string>()
  const refundVouchers: OssUnaccountedVoucher[] = []
  for (const entry of entries) {
    if (cancelled.has(entry.id) || accounted.has(entry.id)) continue
    const placed = placeByAccounts(entry, revenueAccounts, vatAccounts, input.accountCountries)
    if (!placed.ok) {
      for (const account of placed.accountsWithoutCountry) accountsWithoutCountry.add(account)
      continue
    }

    // The storno or rättelse of a verifikat dated before the quarter corrects
    // the quarter that verifikat was declared in. One whose original cannot
    // be read stays outside: which quarter it belongs to is unknown.
    let corrects: OssQuarterRef | null = null
    const linkedId = entry.reverses_id ?? entry.correction_of_id
    if (linkedId && !byId.has(linkedId)) {
      const linkedDate = input.linkedEntryDates.get(linkedId)
      if (!linkedDate) continue
      if (linkedDate < bounds.start) corrects = ossQuarterOf(linkedDate)
    }

    accounted.add(entry.id)
    for (const placement of placed.placements) {
      const sums = {
        net: placement.net_sek,
        vat: placement.vat_sek,
        net_sek: placement.net_sek,
        vat_sek: placement.vat_sek,
      }
      if (corrects) {
        addAmounts(correctionFor(placement.country, corrects), { voucherId: entry.id }, LEDGER_CURRENCY, sums)
        continue
      }
      const row = rowFor(placement.country, placement.vat_rate)
      addAmounts(row, { voucherId: entry.id }, LEDGER_CURRENCY, sums)
      row.ledger.net_sek = roundOre(row.ledger.net_sek + placement.net_sek)
      row.ledger.vat_sek = roundOre(row.ledger.vat_sek + placement.vat_sek)
      row.ledger.lines += placement.lines
    }
    // A refund booked as a verifikat of its own: nothing links it to the sale.
    if (!corrects) {
      const voucher = voucherOf(entry)
      if (voucher.net_sek < 0) refundVouchers.push(voucher)
    }
  }

  let ledgerVatSek = 0
  const unaccounted: OssUnaccountedVoucher[] = []
  for (const entry of entries) {
    const voucher = voucherOf(entry)
    ledgerVatSek += voucher.vat_sek
    if (cancelled.has(entry.id) || accounted.has(entry.id)) continue
    unaccounted.push(voucher)
  }
  unaccounted.sort(byVoucher)
  refundVouchers.sort(byVoucher)

  const warnings: OssUnderlagWarning[] = []
  const unbooked: string[] = []
  const foreignNotOss: string[] = []
  for (const order of input.quarterOrders) {
    if (!destinationOf(order)) continue
    const linked = linkedEntryId(order)
    const vatBuckets = order.vat_breakdown.filter((bucket) => bucket.tax !== 0)
    // A verifikat reversed in a later quarter still books the order here.
    const released = !!linked && !!input.releasedEntryIds?.has(linked) && !booked.has(order.id)
    if (!linked || released) {
      const handledElsewhere = !!order.manually_booked_at || !!order.invoice_id || !!order.legacy_transaction_id
      if (order.is_paid && !handledElsewhere && vatBuckets.length > 0) unbooked.push(order.order_number)
    } else if (!byId.has(linked) && vatBuckets.some((bucket) => !isSwedishRate(bucket.rate))) {
      foreignNotOss.push(order.order_number)
    }
  }
  if (unbooked.length > 0) warnings.push(warning('unbooked_orders', unbooked))
  if (foreignNotOss.length > 0) warnings.push(warning('foreign_vat_not_oss', foreignNotOss))
  if (notPlaceable.length > 0) warnings.push(warning('orders_not_placeable', notPlaceable))
  if (refundsWithoutOssParent.length > 0) warnings.push(warning('refund_parent_not_oss', refundsWithoutOssParent))
  if (unaccounted.length > 0) warnings.push(warning('vouchers_without_order'))
  if (refundVouchers.length > 0) warnings.push(warning('refund_vouchers_netted'))

  return {
    rows,
    corrections,
    unaccounted,
    refundVouchers,
    accountsWithoutCountry: Array.from(accountsWithoutCountry).sort(),
    ledgerVatSek: roundOre(ledgerVatSek),
    warnings,
  }
}

/** The (currency, day) pairs whose ECB rate the classification needs. */
export function ossRateNeeds(classification: OssClassification, quarter: OssQuarterRef): Array<{ currency: string; date: string }> {
  const needs = new Map<string, { currency: string; date: string }>()
  const add = (currency: string, ref: OssQuarterRef) => {
    const date = ossQuarterBounds(ref.year, ref.quarter).end
    needs.set(`${currency}|${date}`, { currency, date })
  }
  for (const row of classification.rows.values()) for (const currency of row.byCurrency.keys()) add(currency, quarter)
  for (const correction of classification.corrections.values()) {
    for (const currency of correction.byCurrency.keys()) add(currency, correction.period)
  }
  return Array.from(needs.values()).sort((a, b) => a.date.localeCompare(b.date) || a.currency.localeCompare(b.currency))
}

// ---------------------------------------------------------------------------
// Conversion to euro (pure)
// ---------------------------------------------------------------------------

function toEur(byCurrency: Map<string, CurrencyAmounts>, date: string, rates: ReadonlyMap<string, EcbRateLookup>) {
  let net = 0
  let vat = 0
  for (const sums of byCurrency.values()) {
    const lookup = rates.get(`${sums.currency}|${date}`)
    const rate = lookup?.ok ? lookup.rate?.rate : undefined
    if (!rate) return null
    net += sums.net / rate
    vat += sums.vat / rate
  }
  return { net: roundOre(net), vat: roundOre(vat) }
}

function sumOf(values: Array<number | null>): number | null {
  if (values.some((value) => value === null)) return null
  return roundOre(values.reduce<number>((total, value) => total + (value ?? 0), 0))
}

/**
 * The underlag from a classification and the ECB rates it needs (keyed
 * currency|date). `accounts` is what the chart says about the OSS accounts
 * (ossAccountsOf); the amounts do not depend on it.
 */
export function finalizeOssUnderlag(
  quarter: OssQuarterRef,
  classification: OssClassification,
  rates: ReadonlyMap<string, EcbRateLookup>,
  accounts: OssAccount[] = [],
): OssUnderlag {
  const bounds = ossQuarterBounds(quarter.year, quarter.quarter)

  const rows: OssUnderlagRow[] = Array.from(classification.rows.values())
    .map((row) => {
      const eur = toEur(row.byCurrency, bounds.end, rates)
      const sums = Array.from(row.byCurrency.values())
      return {
        country: row.country,
        vat_rate: row.vat_rate,
        net_eur: eur?.net ?? null,
        vat_eur: eur?.vat ?? null,
        net_sek: roundOre(sums.reduce((total, s) => total + s.net_sek, 0)),
        vat_sek: roundOre(sums.reduce((total, s) => total + s.vat_sek, 0)),
        order_count: row.orderIds.size,
        voucher_count: row.voucherIds.size,
        rate_mismatch: ledgerRateMismatch(row.vat_rate, row.ledger),
      }
    })
    .sort((a, b) => a.country.localeCompare(b.country) || a.vat_rate - b.vat_rate)

  const corrections: OssUnderlagCorrection[] = Array.from(classification.corrections.values())
    .map((correction) => {
      const { end } = ossQuarterBounds(correction.period.year, correction.period.quarter)
      const eur = toEur(correction.byCurrency, end, rates)
      const sums = Array.from(correction.byCurrency.values())
      return {
        country: correction.country,
        period: { ...correction.period, label: quarterLabel(correction.period) },
        vat_eur: eur?.vat ?? null,
        vat_sek: roundOre(sums.reduce((total, s) => total + s.vat_sek, 0)),
        refund_count: correction.orderIds.size,
        voucher_count: correction.voucherIds.size,
      }
    })
    .sort((a, b) => quarterKey(a.period).localeCompare(quarterKey(b.period)) || a.country.localeCompare(b.country))

  const rateList: OssEuroRate[] = ossRateNeeds(classification, quarter).map(({ currency, date }) => {
    const lookup = rates.get(`${currency}|${date}`)
    const rate = lookup?.ok ? lookup.rate : null
    return {
      currency,
      for_date: date,
      rate: rate?.rate ?? null,
      rate_date: rate?.date ?? null,
      unavailable: !rate,
    }
  })

  const warnings = [...classification.warnings]
  if (rows.some((row) => row.rate_mismatch)) warnings.push(warning('vat_rate_mismatch'))
  if (rateList.some((rate) => rate.unavailable)) warnings.push(warning('rate_unavailable'))

  // A nil return only when nothing says otherwise. Empty rows are not enough:
  // a sale booked by hand on the OSS accounts has no order to take country
  // and rate from, so it reaches `unaccounted` and the ledger total but never
  // a row, and answering "nothing to declare" beside it invites a nil return
  // for a quarter with OSS VAT in the books (crm#1902). Every classification
  // warning names something left outside the underlag; the ledger total
  // catches what no warning names.
  const nilReturn =
    rows.length === 0
    && corrections.length === 0
    && classification.unaccounted.length === 0
    && classification.warnings.length === 0
    && classification.ledgerVatSek === 0

  return {
    period: { ...quarter, ...bounds, label: quarterLabel(quarter), deadline: ossDeadline(quarter.year, quarter.quarter) },
    rows,
    corrections,
    totals: {
      net_eur: sumOf(rows.map((row) => row.net_eur)),
      vat_eur: sumOf(rows.map((row) => row.vat_eur)),
      corrections_vat_eur: sumOf(corrections.map((correction) => correction.vat_eur)),
      net_sek: roundOre(rows.reduce((total, row) => total + row.net_sek, 0)),
      vat_sek: roundOre(rows.reduce((total, row) => total + row.vat_sek, 0)),
      corrections_vat_sek: roundOre(corrections.reduce((total, correction) => total + correction.vat_sek, 0)),
    },
    rates: rateList,
    ledger_vat_sek: classification.ledgerVatSek,
    unaccounted: classification.unaccounted,
    refund_vouchers: classification.refundVouchers,
    accounts,
    warnings,
    nil_return: nilReturn,
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const EU_DESTINATIONS = EU_COUNTRIES.map((country) => country.code).filter((code) => code !== 'SE')

const ID_CHUNK = 100

/** A chart account as the underlag reads it. */
export interface OssChartAccount {
  account_number: string
  account_name: string
  /** The country the account names, or null. */
  country: string | null
  /** Percent, or null. */
  vat_rate: number | null
}

interface OssChartRow {
  account_number: string
  account_name: string | null
  oss_country: string | null
  oss_vat_rate: number | string | null
}

function chartAccount(row: OssChartRow): OssChartAccount {
  return {
    account_number: row.account_number,
    account_name: row.account_name ?? '',
    country: row.oss_country ?? null,
    // numeric(5,2) arrives as a number or, from some drivers, as text.
    vat_rate: row.oss_vat_rate == null ? null : Number(row.oss_vat_rate),
  }
}

/** A name that says the account holds VAT. */
const VAT_ACCOUNT_NAME = /moms|\bvat\b/i

/**
 * The OSS accounts a reader sets the country on: the ones that name one, the
 * sales accounts a verifikat in `unaccounted` waits for and, for a company
 * that places sales by account, the VAT accounts whose name states a country
 * (a VAT account that names none is not read as OSS VAT, so the sales booked
 * with it would show no VAT).
 */
export function ossAccountsOf(input: {
  /** Class 3 accounts with VAT code OSS. */
  salesAccounts: readonly OssChartAccount[]
  /** 26xx accounts other than 2650. */
  vatAccounts: readonly OssChartAccount[]
  /** VAT accounts read as OSS VAT whatever they name: the OSS output VAT account and those country rules name. */
  ossVatAccounts: ReadonlySet<string>
  accountsWithoutCountry: readonly string[]
}): OssAccount[] {
  const waitedFor = new Set(input.accountsWithoutCountry)
  const accounts: OssAccount[] = []

  for (const account of input.salesAccounts) {
    const named = account.country !== null && account.vat_rate !== null
    if (!named && !waitedFor.has(account.account_number)) continue
    const suggested = named ? null : suggestOssAccount(account.account_name)
    accounts.push({
      account_number: account.account_number,
      account_name: account.account_name,
      kind: 'sales',
      country: named ? account.country : null,
      vat_rate: named ? account.vat_rate : null,
      suggested_country: suggested?.country ?? null,
      suggested_vat_rate: suggested?.vat_rate ?? null,
      blocks_vouchers: !named,
    })
  }

  const placesByAccount = accounts.length > 0
  for (const account of input.vatAccounts) {
    let suggestedCountry: string | null = null
    if (account.country === null) {
      if (!placesByAccount || input.ossVatAccounts.has(account.account_number)) continue
      if (!VAT_ACCOUNT_NAME.test(account.account_name)) continue
      suggestedCountry = suggestOssAccount(account.account_name).country
      if (!suggestedCountry) continue
    }
    accounts.push({
      account_number: account.account_number,
      account_name: account.account_name,
      kind: 'vat',
      country: account.country,
      vat_rate: null,
      suggested_country: suggestedCountry,
      suggested_vat_rate: null,
      blocks_vouchers: false,
    })
  }

  return accounts.sort((a, b) => a.account_number.localeCompare(b.account_number))
}

/**
 * The country of each VAT account that the OSS country rules name for one
 * country only: a rule "Germany books its VAT on this account" says whose VAT
 * the account holds, also for a verifikat that books no order. An account the
 * rules name for several countries, or for the EU catch-all, is shared and
 * absent here.
 */
export function ruleVatAccountCountries(ruleCountries: ReadonlyMap<string, ReadonlySet<string>>): Map<string, string> {
  const countries = new Map<string, string>()
  for (const [account, named] of ruleCountries) {
    if (named.size !== 1) continue
    const [country] = named
    if (isOtherEuCountry(country)) countries.set(account, country)
  }
  return countries
}

/**
 * The company's OSS accounts and the country each names. Revenue: VAT code
 * OSS, or named by an OSS country rule. VAT: the OSS output VAT account,
 * those OSS country rules name, and every 26xx account that names a country.
 * A VAT account takes its country from its own row, else from the country
 * rules when they name it for one country; with neither it is shared.
 */
async function loadOssAccounts(supabase: SupabaseClient, companyId: string) {
  const revenueAccounts = new Set<string>()
  const vatAccounts = new Set<string>([OSS_VAT_ACCOUNT])
  const accountCountries = new Map<string, OssAccountCountry>()

  const { data: treated, error: chartError } = await supabase
    .from('chart_of_accounts')
    .select('account_number, account_name, oss_country, oss_vat_rate')
    .eq('company_id', companyId)
    .eq('default_vat_treatment', 'oss')
  if (chartError) throw new Error(`chart_of_accounts read failed: ${chartError.message}`)
  const salesChart = ((treated ?? []) as OssChartRow[]).map(chartAccount)
  for (const account of salesChart) {
    revenueAccounts.add(account.account_number)
    if (account.country !== null && account.vat_rate !== null) {
      accountCountries.set(account.account_number, { country: account.country, vat_rate: account.vat_rate })
    }
  }

  // Class 26 is a few dozen rows per company; isVatBoxAccount picks the
  // ones that can hold OSS VAT.
  const { data: class26, error: vatChartError } = await supabase
    .from('chart_of_accounts')
    .select('account_number, account_name, oss_country, oss_vat_rate')
    .eq('company_id', companyId)
    .like('account_number', '26%')
  if (vatChartError) throw new Error(`chart_of_accounts read failed: ${vatChartError.message}`)
  const vatChart = ((class26 ?? []) as OssChartRow[])
    .filter((row) => isVatBoxAccount(row.account_number))
    .map(chartAccount)
  for (const account of vatChart) {
    if (account.country === null) continue
    vatAccounts.add(account.account_number)
    accountCountries.set(account.account_number, { country: account.country, vat_rate: null })
  }

  const { data: stores, error: storeError } = await supabase
    .from('webshop_store_settings')
    .select('country_account_rules')
    .eq('company_id', companyId)
  if (storeError) throw new Error(`webshop_store_settings read failed: ${storeError.message}`)
  const ruleCountries = new Map<string, Set<string>>()
  for (const store of (stores ?? []) as Array<{ country_account_rules: WebshopCountryAccountRule[] | null }>) {
    for (const rule of store.country_account_rules ?? []) {
      if (rule.mode !== 'accounts' || !isOssRule(rule)) continue
      revenueAccounts.add(rule.revenue_account)
      if (!rule.vat_account) continue
      vatAccounts.add(rule.vat_account)
      const countries = ruleCountries.get(rule.vat_account) ?? new Set<string>()
      countries.add(rule.country.toUpperCase())
      ruleCountries.set(rule.vat_account, countries)
    }
  }
  for (const [account, country] of ruleVatAccountCountries(ruleCountries)) {
    // What the account itself names wins over what the rules say about it.
    if (!accountCountries.has(account)) accountCountries.set(account, { country, vat_rate: null })
  }
  return { revenueAccounts, vatAccounts, accountCountries, salesChart, vatChart }
}

/** The date of each of the verifikat, for the ones that exist. */
async function loadEntryDates(supabase: SupabaseClient, companyId: string, entryIds: string[]): Promise<Map<string, string>> {
  const dates = new Map<string, string>()
  for (const chunk of chunks(entryIds, ID_CHUNK)) {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('id, entry_date')
      .eq('company_id', companyId)
      .in('status', ['posted', 'reversed'])
      .in('id', chunk)
    if (error) throw new Error(`journal_entries read failed: ${error.message}`)
    for (const entry of (data ?? []) as Array<{ id: string; entry_date: string }>) dates.set(entry.id, entry.entry_date)
  }
  return dates
}

/** The quarter's posted and reversed verifikat on the OSS accounts, with just those lines. */
async function loadOssEntries(
  supabase: SupabaseClient,
  companyId: string,
  start: string,
  end: string,
  accounts: string[],
): Promise<OssEntry[]> {
  const rows = await fetchEntriesWithAccountLines(supabase, companyId, {
    start,
    end,
    accounts,
    statuses: ['posted', 'reversed'],
    allLines: false,
  })
  if (rows) return rows

  // A database without get_entries_with_account_lines yet (a self-hosted
  // instance not migrated): the same rows the paged way, driven from
  // journal_entries with the account condition as an inner embed.
  const paged = await fetchAllRows<Omit<OssEntry, 'lines'> & { journal_entry_lines: OssEntry['lines'] }>(({ from, to }) =>
    supabase
      .from('journal_entries')
      .select('id, voucher_series, voucher_number, entry_date, description, status, reverses_id, correction_of_id, journal_entry_lines!inner(account_number, debit_amount, credit_amount)')
      .eq('company_id', companyId)
      .in('status', ['posted', 'reversed'])
      .gte('entry_date', start)
      .lte('entry_date', end)
      .in('journal_entry_lines.account_number', accounts)
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
        data: Array<Omit<OssEntry, 'lines'> & { journal_entry_lines: OssEntry['lines'] }> | null
        error: { message: string } | null
      }>,
  )
  return paged.map(({ journal_entry_lines, ...entry }) => ({ ...entry, lines: journal_entry_lines }))
}

/** The orders linked (booked or marked as booked) to any of the verifikat. */
async function loadLinkedOrders(supabase: SupabaseClient, companyId: string, entryIds: string[]): Promise<OssOrder[]> {
  const byId = new Map<string, OssOrder>()
  const keep = (data: unknown, error: { message: string } | null) => {
    if (error) throw new Error(`webshop_orders read failed: ${error.message}`)
    for (const order of (data ?? []) as OssOrder[]) byId.set(order.id, order)
  }
  // Literal selects and columns, one query per link: the phantom-column
  // guard (tests/schema/no-phantom-columns.test.ts) checks only what it can read.
  for (const chunk of chunks(entryIds, ID_CHUNK)) {
    const booked = await supabase
      .from('webshop_orders')
      .select('id, platform, row_type, parent_order_id, order_number, customer_country, currency, exchange_rate, vat_breakdown, journal_entry_id, manually_booked_journal_entry_id, manually_booked_at, invoice_id, legacy_transaction_id, is_paid, paid_date, order_date')
      .eq('company_id', companyId)
      .in('journal_entry_id', chunk)
    keep(booked.data, booked.error)
    const marked = await supabase
      .from('webshop_orders')
      .select('id, platform, row_type, parent_order_id, order_number, customer_country, currency, exchange_rate, vat_breakdown, journal_entry_id, manually_booked_journal_entry_id, manually_booked_at, invoice_id, legacy_transaction_id, is_paid, paid_date, order_date')
      .eq('company_id', companyId)
      .in('manually_booked_journal_entry_id', chunk)
    keep(marked.data, marked.error)
  }
  return Array.from(byId.values())
}

/**
 * For each parent order: the date of its OSS verifikat, or null when it has
 * none (not booked, or booked without an OSS account).
 */
async function loadParentBookingDates(
  supabase: SupabaseClient,
  companyId: string,
  parentIds: string[],
  accounts: string[],
): Promise<Map<string, string | null>> {
  const dates = new Map<string, string | null>(parentIds.map((id) => [id, null]))
  if (parentIds.length === 0) return dates

  const parents: Array<Pick<OssOrder, 'id' | 'journal_entry_id' | 'manually_booked_journal_entry_id'>> = []
  for (const chunk of chunks(parentIds, ID_CHUNK)) {
    const { data, error } = await supabase
      .from('webshop_orders')
      .select('id, journal_entry_id, manually_booked_journal_entry_id')
      .eq('company_id', companyId)
      .in('id', chunk)
    if (error) throw new Error(`webshop_orders read failed: ${error.message}`)
    parents.push(...((data ?? []) as typeof parents))
  }

  const entryIds = Array.from(new Set(parents.map(linkedEntryId).filter((id): id is string => !!id)))
  const entryDates = new Map<string, string>()
  for (const chunk of chunks(entryIds, ID_CHUNK)) {
    const { data, error } = await supabase
      .from('journal_entries')
      .select('id, entry_date')
      .eq('company_id', companyId)
      .in('status', ['posted', 'reversed'])
      .in('id', chunk)
    if (error) throw new Error(`journal_entries read failed: ${error.message}`)
    for (const entry of (data ?? []) as Array<{ id: string; entry_date: string }>) entryDates.set(entry.id, entry.entry_date)
  }
  const onOssAccounts = new Set(
    (await fetchLinesByEntryIds<{ id: string; journal_entry_id: string }>(
      supabase,
      Array.from(entryDates.keys()),
      'id, journal_entry_id',
      (query) => query.in('account_number', accounts),
    )).map((line) => line.journal_entry_id),
  )

  for (const parent of parents) {
    const entryId = linkedEntryId(parent)
    if (entryId && onOssAccounts.has(entryId)) dates.set(parent.id, entryDates.get(entryId) ?? null)
  }
  return dates
}

/** Shopify rows to another EU country paid in the quarter (ordered, when unpaid), for the warnings. */
async function loadQuarterOrders(supabase: SupabaseClient, companyId: string, start: string, end: string): Promise<OssOrder[]> {
  type Page = PromiseLike<{ data: OssOrder[] | null; error: { message: string } | null }>
  const [paid, unpaid] = await Promise.all([
    fetchAllRows<OssOrder>(({ from, to }) =>
      supabase
        .from('webshop_orders')
        .select('id, platform, row_type, parent_order_id, order_number, customer_country, currency, exchange_rate, vat_breakdown, journal_entry_id, manually_booked_journal_entry_id, manually_booked_at, invoice_id, legacy_transaction_id, is_paid, paid_date, order_date')
        .eq('company_id', companyId)
        .eq('platform', 'shopify')
        .in('customer_country', EU_DESTINATIONS)
        .gte('paid_date', start)
        .lte('paid_date', end)
        .order('id', { ascending: true })
        .range(from, to) as unknown as Page,
    ),
    fetchAllRows<OssOrder>(({ from, to }) =>
      supabase
        .from('webshop_orders')
        .select('id, platform, row_type, parent_order_id, order_number, customer_country, currency, exchange_rate, vat_breakdown, journal_entry_id, manually_booked_journal_entry_id, manually_booked_at, invoice_id, legacy_transaction_id, is_paid, paid_date, order_date')
        .eq('company_id', companyId)
        .eq('platform', 'shopify')
        .in('customer_country', EU_DESTINATIONS)
        .is('paid_date', null)
        .gte('order_date', start)
        .lte('order_date', end)
        .order('id', { ascending: true })
        .range(from, to) as unknown as Page,
    ),
  ])
  return [...paid, ...unpaid]
}

/** The OSS underlag for a calendar quarter. */
export async function generateOssUnderlag(
  supabase: SupabaseClient,
  companyId: string,
  year: number,
  quarter: number,
): Promise<OssUnderlag> {
  const ref = { year, quarter }
  const { start, end } = ossQuarterBounds(year, quarter)
  const { revenueAccounts, vatAccounts, accountCountries, salesChart, vatChart } = await loadOssAccounts(supabase, companyId)
  const accounts = Array.from(new Set([...revenueAccounts, ...vatAccounts])).sort()

  const [entries, quarterOrders] = await Promise.all([
    loadOssEntries(supabase, companyId, start, end, accounts),
    loadQuarterOrders(supabase, companyId, start, end),
  ])
  const orders = await loadLinkedOrders(supabase, companyId, entries.map((entry) => entry.id))
  const released = await readReleasedWebshopBookings(
    supabase,
    companyId,
    quarterOrders.map((order) => order.journal_entry_id),
  )
  const orderIds = new Set(orders.map((order) => order.id))
  const parentIds = Array.from(
    new Set(
      orders
        .filter((order) => order.row_type === 'refund' && order.parent_order_id && !orderIds.has(order.parent_order_id))
        .map((order) => order.parent_order_id as string),
    ),
  )
  const parentBookingDates = await loadParentBookingDates(supabase, companyId, parentIds, accounts)

  // The verifikat a storno or rättelse of the quarter points at, when it is
  // dated outside the quarter: its date names the quarter being corrected.
  const entryIds = new Set(entries.map((entry) => entry.id))
  const linkedIds = Array.from(
    new Set(
      entries
        .flatMap((entry) => [entry.reverses_id, entry.correction_of_id])
        .filter((id): id is string => !!id && !entryIds.has(id)),
    ),
  )
  const linkedEntryDates = await loadEntryDates(supabase, companyId, linkedIds)

  const classification = classifyOssBookings({
    quarter: ref,
    revenueAccounts,
    vatAccounts,
    entries,
    orders,
    parentBookingDates,
    accountCountries,
    linkedEntryDates,
    quarterOrders,
    releasedEntryIds: new Set(released.keys()),
  })

  const needs = ossRateNeeds(classification, ref)
  const lookups = await Promise.all(needs.map(({ currency, date }) => fetchEcbEuroRate(currency, date)))
  const rates = new Map(needs.map(({ currency, date }, i) => [`${currency}|${date}`, lookups[i]]))

  return finalizeOssUnderlag(
    ref,
    classification,
    rates,
    ossAccountsOf({
      salesAccounts: salesChart,
      vatAccounts: vatChart,
      ossVatAccounts: vatAccounts,
      accountsWithoutCountry: classification.accountsWithoutCountry,
    }),
  )
}

export interface OssUnderlagInput {
  year: number
  quarter: number
}

/** The underlag behind every door: the dashboard routes, v1 and MCP. A read: never a dry run. */
export async function getOssUnderlag(
  ctx: OperationContext,
  input: OssUnderlagInput,
): Promise<Exclude<OperationOutcome<OssUnderlag>, { dryRun: true }>> {
  try {
    return { ok: true, data: await generateOssUnderlag(ctx.supabase, ctx.companyId, input.year, input.quarter) }
  } catch (err) {
    ctx.log.error('OSS underlag failed', err as Error, { ...input })
    return {
      ok: false,
      code: 'OSS_UNDERLAG_FAILED',
      details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
    }
  }
}
