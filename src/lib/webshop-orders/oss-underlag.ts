import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchEntriesWithAccountLines, fetchLinesByEntryIds } from '@/lib/bookkeeping/entry-lines'
import { fetchEcbEuroRate, type EcbRateLookup } from '@/lib/currency/ecb'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { roundOre } from '@/lib/money'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { EU_COUNTRIES, isEuMemberCountry } from '@/lib/vat/eu-countries'
import type { WebshopCountryAccountRule, WebshopOrder } from '@/types'
import { OSS_VAT_ACCOUNT, SWEDISH_RULE_RATES, isOssRule, sameVatRate } from './country-routing'

/**
 * Underlag for the OSS declaration (unionsordningen): per quarter, the sales
 * to consumers in other EU countries by country and VAT rate, in euro, plus
 * the corrections of earlier quarters, from the webshop orders booked on the
 * OSS accounts.
 *
 * Why it reads the orders and not only the ledger: the "Vi redovisar OSS"
 * country rule books every EU country on one shared pair (3106/2670), so the
 * ledger alone cannot say which country a krona belongs to. The order row can
 * (Shopify's destination country and VAT split). The ledger decides WHICH
 * orders count and WHEN: an order counts in the quarter of the verifikat that
 * books it on an OSS account, and every OSS-account verifikat that books no
 * order is listed, so the underlag never leaves out a posting silently.
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
 * exactly what was declared (docs/decisions/2026-10).
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
}

export interface OssUnderlagCorrection {
  country: string
  /** The quarter the corrected sale was declared in. */
  period: OssQuarterRef & { label: string }
  /** Negative for a refund. Null while an ECB rate is missing. */
  vat_eur: number | null
  vat_sek: number
  refund_count: number
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

/** A verifikat on an OSS account that books no order in the underlag. */
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
  unaccounted: OssUnaccountedVoucher[]
  warnings: OssUnderlagWarning[]
  /** Nothing to declare: Skatteverket still wants a declaration (a nil return). */
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
  /**
   * Shopify rows to another EU country paid (or ordered) in the quarter,
   * booked or not, for the warnings about orders missing from the underlag.
   */
  quarterOrders: readonly OssOrder[]
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
}

export interface OssClassification {
  /** country|rate → sums per currency. */
  rows: Map<string, Aggregate & { country: string; vat_rate: number }>
  /** country|quarter → sums per currency. */
  corrections: Map<string, Aggregate & { country: string; period: OssQuarterRef }>
  unaccounted: OssUnaccountedVoucher[]
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
  if (!country || country === 'SE' || !isEuMemberCountry(country)) return null
  return country
}

/** Rates are percentages with at most two decimals (25.5). */
function rateKey(rate: number): number {
  return roundOre(rate)
}

function addAmounts(
  aggregate: Aggregate,
  orderId: string,
  currency: string,
  sums: Omit<CurrencyAmounts, 'currency'>,
): void {
  const current = aggregate.byCurrency.get(currency) ?? { currency, net: 0, vat: 0, net_sek: 0, vat_sek: 0 }
  current.net += sums.net
  current.vat += sums.vat
  current.net_sek = roundOre(current.net_sek + sums.net_sek)
  current.vat_sek = roundOre(current.vat_sek + sums.vat_sek)
  aggregate.byCurrency.set(currency, current)
  aggregate.orderIds.add(orderId)
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
      net_sek: sign * roundOre(Math.abs(bucket.net) * sekRate),
      vat_sek: sign * roundOre(Math.abs(bucket.tax) * sekRate),
    }))
}

function isSwedishRate(rate: number): boolean {
  return SWEDISH_RULE_RATES.some((swedish) => sameVatRate(swedish, rate))
}

/**
 * Which orders the quarter's OSS verifikat book, and what is left over.
 *
 * - A verifikat and its storno in the same quarter cancel: neither counts.
 * - An order counts through the verifikat linked to it, or, when that one
 *   was reversed in the quarter, through the rättelse that replaced it.
 * - A verifikat reversed in a LATER quarter still counts here: in this
 *   quarter the books held it, and the storno is that later quarter's matter.
 * - Every other verifikat on an OSS account (a manual one, a storno or a
 *   rättelse of an earlier quarter's verifikat) books no order and is listed
 *   in `unaccounted` with its amounts.
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
      if (!corrects) {
        const key = `${country}|${bucket.rate}`
        const row = rows.get(key) ?? { country, vat_rate: bucket.rate, byCurrency: new Map(), orderIds: new Set<string>() }
        addAmounts(row, order.id, currency, bucket)
        rows.set(key, row)
      } else {
        const key = `${country}|${quarterKey(corrects)}`
        const correction = corrections.get(key) ?? { country, period: corrects, byCurrency: new Map(), orderIds: new Set<string>() }
        addAmounts(correction, order.id, currency, bucket)
        corrections.set(key, correction)
      }
    }
  }

  let ledgerVatSek = 0
  const unaccounted: OssUnaccountedVoucher[] = []
  for (const entry of entries) {
    let net = 0
    let vat = 0
    for (const line of entry.lines) {
      const movement = amount(line.credit_amount) - amount(line.debit_amount)
      if (vatAccounts.has(line.account_number)) vat += movement
      else if (revenueAccounts.has(line.account_number)) net += movement
    }
    ledgerVatSek += vat
    if (cancelled.has(entry.id) || accounted.has(entry.id)) continue
    unaccounted.push({
      journal_entry_id: entry.id,
      voucher_series: entry.voucher_series,
      voucher_number: entry.voucher_number,
      entry_date: entry.entry_date,
      description: entry.description,
      net_sek: roundOre(net),
      vat_sek: roundOre(vat),
    })
  }
  unaccounted.sort((a, b) =>
    a.entry_date.localeCompare(b.entry_date)
    || (a.voucher_series ?? '').localeCompare(b.voucher_series ?? '')
    || a.voucher_number - b.voucher_number,
  )

  const warnings: OssUnderlagWarning[] = []
  const unbooked: string[] = []
  const foreignNotOss: string[] = []
  for (const order of input.quarterOrders) {
    if (!destinationOf(order)) continue
    const linked = linkedEntryId(order)
    const vatBuckets = order.vat_breakdown.filter((bucket) => bucket.tax !== 0)
    if (!linked) {
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

  return { rows, corrections, unaccounted, ledgerVatSek: roundOre(ledgerVatSek), warnings }
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

/** The underlag from a classification and the ECB rates it needs (keyed currency|date). */
export function finalizeOssUnderlag(
  quarter: OssQuarterRef,
  classification: OssClassification,
  rates: ReadonlyMap<string, EcbRateLookup>,
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
  if (rateList.some((rate) => rate.unavailable)) warnings.push(warning('rate_unavailable'))

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
    warnings,
    nil_return: rows.length === 0 && corrections.length === 0,
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const EU_DESTINATIONS = EU_COUNTRIES.map((country) => country.code).filter((code) => code !== 'SE')

const ID_CHUNK = 100

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += ID_CHUNK) out.push(items.slice(i, i + ID_CHUNK))
  return out
}

/** The company's OSS revenue and VAT accounts. */
async function loadOssAccounts(supabase: SupabaseClient, companyId: string) {
  const revenueAccounts = new Set<string>()
  const vatAccounts = new Set<string>([OSS_VAT_ACCOUNT])

  const { data: treated, error: chartError } = await supabase
    .from('chart_of_accounts')
    .select('account_number')
    .eq('company_id', companyId)
    .eq('default_vat_treatment', 'oss')
  if (chartError) throw new Error(`chart_of_accounts read failed: ${chartError.message}`)
  for (const row of (treated ?? []) as Array<{ account_number: string }>) revenueAccounts.add(row.account_number)

  const { data: stores, error: storeError } = await supabase
    .from('webshop_store_settings')
    .select('country_account_rules')
    .eq('company_id', companyId)
  if (storeError) throw new Error(`webshop_store_settings read failed: ${storeError.message}`)
  for (const store of (stores ?? []) as Array<{ country_account_rules: WebshopCountryAccountRule[] | null }>) {
    for (const rule of store.country_account_rules ?? []) {
      if (rule.mode !== 'accounts' || !isOssRule(rule)) continue
      revenueAccounts.add(rule.revenue_account)
      if (rule.vat_account) vatAccounts.add(rule.vat_account)
    }
  }
  return { revenueAccounts, vatAccounts }
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
  for (const chunk of chunks(entryIds)) {
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
  for (const chunk of chunks(parentIds)) {
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
  for (const chunk of chunks(entryIds)) {
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
  const { revenueAccounts, vatAccounts } = await loadOssAccounts(supabase, companyId)
  const accounts = Array.from(new Set([...revenueAccounts, ...vatAccounts])).sort()

  const [entries, quarterOrders] = await Promise.all([
    loadOssEntries(supabase, companyId, start, end, accounts),
    loadQuarterOrders(supabase, companyId, start, end),
  ])
  const orders = await loadLinkedOrders(supabase, companyId, entries.map((entry) => entry.id))
  const orderIds = new Set(orders.map((order) => order.id))
  const parentIds = Array.from(
    new Set(
      orders
        .filter((order) => order.row_type === 'refund' && order.parent_order_id && !orderIds.has(order.parent_order_id))
        .map((order) => order.parent_order_id as string),
    ),
  )
  const parentBookingDates = await loadParentBookingDates(supabase, companyId, parentIds, accounts)

  const classification = classifyOssBookings({
    quarter: ref,
    revenueAccounts,
    vatAccounts,
    entries,
    orders,
    parentBookingDates,
    quarterOrders,
  })

  const needs = ossRateNeeds(classification, ref)
  const lookups = await Promise.all(needs.map(({ currency, date }) => fetchEcbEuroRate(currency, date)))
  const rates = new Map(needs.map(({ currency, date }, i) => [`${currency}|${date}`, lookups[i]]))

  return finalizeOssUnderlag(ref, classification, rates)
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
