import { sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import { splitGrossVat } from '@/lib/bookkeeping/gross-split'
import { roundOre as round } from '@/lib/money'
import type {
  CreateJournalEntryLineInput,
  WebshopOrder,
  WebshopStoreSettings,
  WebshopVatBreakdownLine,
} from '@/types'
import {
  routeOrderBuckets,
  usesSwedishAccounts,
  type OrderRouting,
  type RoutableOrder,
} from './country-routing'

/**
 * Pure builder for the journal lines that PREFILL the order booking dialog.
 * Never books anything on its own: the user reviews and can override every
 * line (manual-base doctrine), and the server only validates what comes back
 * through the engine.
 *
 * Shape for an order row (Swish 500 kr incl. 25%):
 *   Debit  1930 (mapped by payment_method)   500.00   gross
 *   Credit 3001                              400.00   net per rate
 *   Credit 2611                              100.00   VAT per rate
 * Refund rows mirror (debit revenue/VAT, credit the payment account).
 * A rounding residual up to MAX_RESIDUAL_SEK goes to 3740 Öresavrundning so
 * the entry balances; a larger gap never does (OrderBookingGap).
 *
 * A Shopify order shipped outside Sweden books each VAT bucket on the store's
 * country rules (country-routing.ts) instead, e.g. 3106/2670 for an OSS sale;
 * a bucket no rule covers, or an order without a destination country in a
 * store with rules, keeps the Swedish accounts here, which only the single
 * dialog may show (as an editable prefill). An order shipped to Sweden, or
 * without a country, books on the store's Sverige row when it has one: its
 * own sales account, the output VAT account for the rate.
 *
 * Non-SEK orders book in SEK via the row's stored exchange_rate (rate date =
 * paid date, captured at sync); every line carries the currency metadata trio
 * exactly like the transaction booking dialog does. Callers must not invoke
 * this while total_sek is null (booking is blocked until FX resolves).
 */

/**
 * Fallback counter-account when no mapping exists.
 *
 * BAS 2026 1686 "Fordringar för kontokort och kuponger": money the payment
 * provider is holding but has not paid out yet. This is the same ledger the
 * Stripe extension settles against, so a store that runs both surfaces keeps
 * one clearing account. 1680 "Andra kortfristiga fordringar" was used before
 * and is the generic parent bucket, not the card/PSP receivable BAS defines
 * for this; bas.se moved this receivable off 1580 onto 1686 precisely because
 * it is a claim on the payment provider, not on the customer.
 */
export const DEFAULT_PAYMENT_ACCOUNT = '1686'

/**
 * Default revenue account per Swedish VAT rate: the standard BAS 2026
 * "Försäljning inom Sverige" accounts. Exported so the bulk dialog can
 * prefill its per-rate revenue pickers with the effective defaults. BAS 2026
 * has no standard goods/services subdivision of 30xx (such a split, e.g. an
 * own 3040-series, is company-specific), which is why the revenue template
 * is a per-rate account choice against the company's own chart rather than
 * a hardcoded varor/tjänster preset.
 */
export const DEFAULT_REVENUE_ACCOUNT_BY_RATE: Readonly<Record<number, string>> = {
  25: '3001',
  12: '3002',
  6: '3003',
  0: '3004',
}

const REVENUE_ACCOUNT_BY_RATE = DEFAULT_REVENUE_ACCOUNT_BY_RATE

/** Output VAT account per rate. */
const VAT_ACCOUNT_BY_RATE: Record<number, string> = {
  25: '2611',
  12: '2621',
  6: '2631',
}

/** Öresavrundning. Exported so the bulk route can find and bound the
 * residual line it emits (a residual above öre scale means the order's
 * totals do not match its VAT breakdown and needs per-order review). */
export const ROUNDING_ACCOUNT = '3740'

/**
 * A gap between an order's gross total and its VAT buckets above this
 * magnitude (SEK) is not öresavrundning: per-bucket öre rounding and FX drift
 * stay well below it. The prefill never books such a gap on 3740, and an
 * unattended booking refuses the order (unattended-lines.ts).
 */
export const MAX_RESIDUAL_SEK = 1

/**
 * Every account this prefill can emit, as a closed set.
 *
 * seed_chart_of_accounts() seeds a minimal chart: 3001/3002/3003 and
 * 2611/2621/2631 are in it, but 3004, 3740 and the clearing account are not.
 * The engine throws AccountsNotInChartError for an account that is missing or
 * inactive, so an untouched company hit that error the moment an order had a
 * rounding residual, a 0%-rate line, or no payment-method mapping. Callers
 * pass this set to ensureWebshopPrefillAccounts() so the accounts our own
 * prefill needs are added to the chart on first use, and only ever these:
 * an account the user typed themselves is never auto-created.
 */
export const WEBSHOP_PREFILL_ACCOUNTS: readonly string[] = [
  DEFAULT_PAYMENT_ACCOUNT,
  ...Object.values(REVENUE_ACCOUNT_BY_RATE),
  ...Object.values(VAT_ACCOUNT_BY_RATE),
  ROUNDING_ACCOUNT,
]

/**
 * The day an order's sale is booked on: the day it was paid, else the day it
 * was placed. Bokför's default verifikat date, and the date of a
 * kontantfaktura made from the order (crm#2322), so both book the sale on the
 * same day.
 */
export function defaultEntryDate(order: Pick<WebshopOrder, 'paid_date' | 'order_date'>): string {
  return (order.paid_date ?? order.order_date).slice(0, 10)
}

/**
 * Resolve the prefilled payment counter-account for an order from the
 * per-store mapping. Returns the account plus whether the store marked this
 * payment method as invoice-flow (the dialog then nudges toward Skapa
 * faktura instead).
 */
export function resolvePaymentAccount(
  order: Pick<WebshopOrder, 'payment_method'>,
  settings: Pick<WebshopStoreSettings, 'payment_method_account_map'> | null | undefined,
): { account: string; invoiceMode: boolean; mapped: boolean } {
  const method = order.payment_method
  const policy = method ? settings?.payment_method_account_map?.[method] : undefined
  if (!policy) return { account: DEFAULT_PAYMENT_ACCOUNT, invoiceMode: false, mapped: false }
  if (policy.mode === 'invoice') {
    return { account: DEFAULT_PAYMENT_ACCOUNT, invoiceMode: true, mapped: true }
  }
  return { account: policy.account, invoiceMode: false, mapped: true }
}

/**
 * The payment methods a store's orders carry, each with a display title, in
 * first-seen order (the mapping form's rows). A needs_review row's title says
 * why the order is held (Zettle: "Dricks ingår: bokför manuellt"), not what
 * the method is, so it never names the method.
 */
export function paymentMethodsSeen(
  rows: ReadonlyArray<Pick<WebshopOrder, 'payment_method' | 'payment_method_title' | 'status'>>,
): Array<{ method: string; title: string | null }> {
  const seen = new Map<string, string | null>()
  for (const row of rows) {
    if (!row.payment_method) continue
    const title = row.status === 'needs_review' ? null : row.payment_method_title
    if (!seen.get(row.payment_method)) seen.set(row.payment_method, title)
  }
  return Array.from(seen.entries()).map(([method, title]) => ({ method, title }))
}

/**
 * When the sync could not build a per-rate breakdown (blocked tax endpoints,
 * plugin-mangled orders), fall back to one bucket whose rate is inferred
 * from the tax/net ratio; null rate when nothing matches, so the dialog
 * shows an editable guess instead of silently wrong accounts.
 */
export function fallbackVatBreakdown(
  total: number,
  totalTax: number,
): WebshopVatBreakdownLine[] {
  const net = round(Math.abs(total) - Math.abs(totalTax))
  const tax = round(Math.abs(totalTax))
  if (net <= 0) return [{ rate: 0, net: round(Math.abs(total)), tax: 0 }]
  if (tax === 0) return [{ rate: 0, net, tax: 0 }]
  const ratio = tax / net
  for (const rate of [25, 12, 6]) {
    if (Math.abs(ratio - rate / 100) < 0.005) return [{ rate, net, tax }]
  }
  // Unknown mix: present as 25% bucket for the user to correct.
  return [{ rate: 25, net, tax }]
}

/**
 * VAT-bucket rates the account maps above can express (Swedish rates). A
 * bucket with any other rate (e.g. a German 19% OSS bucket stored raw by the
 * sync) would fall back to the 25% accounts: acceptable only as the single
 * dialog's editable prefill, never in an unreviewed sweep. Returns the
 * distinct offending rates, empty when every bucket is representable.
 */
export function unsupportedVatRates(breakdown: WebshopVatBreakdownLine[]): number[] {
  const bad = new Set<number>()
  for (const bucket of breakdown) {
    if (REVENUE_ACCOUNT_BY_RATE[bucket.rate] === undefined) bad.add(bucket.rate)
  }
  return Array.from(bad).sort((a, b) => a - b)
}

/**
 * The breakdown an order books from: the store's own per-rate split, or the
 * ratio-inferred single bucket when the store sent none.
 */
export function bookingBreakdown(
  order: Pick<WebshopOrder, 'vat_breakdown' | 'total' | 'total_tax'>,
): WebshopVatBreakdownLine[] {
  return order.vat_breakdown.length > 0
    ? order.vat_breakdown
    : fallbackVatBreakdown(order.total, order.total_tax)
}

/** Route an order's VAT buckets through its store's country rules. */
export function routeOrder(
  order: RoutableOrder & Pick<WebshopOrder, 'vat_breakdown' | 'total' | 'total_tax'>,
  settings: Pick<WebshopStoreSettings, 'country_account_rules'> | null | undefined,
): OrderRouting {
  return routeOrderBuckets(order, bookingBreakdown(order), settings?.country_account_rules)
}

/**
 * unsupportedVatRates() for the buckets that book on the Swedish accounts:
 * a bucket a country rule books on its own accounts may carry any rate
 * (19 % to Germany through OSS), the rest must be a Swedish rate.
 */
export function unsupportedSwedishRates(routing: OrderRouting): number[] {
  return unsupportedVatRates(
    routing.buckets.filter(usesSwedishAccounts).map((route) => route.bucket),
  )
}

export type BookingWarning =
  | 'country_not_routed'
  | 'country_unknown'
  | 'zero_rate_foreign'
  | 'foreign_vat'

/**
 * Advisory (never blocking, per the soft-guard rule) compliance hints for
 * the booking dialog:
 * - country_not_routed: a Shopify order shipped outside Sweden with a VAT
 *   bucket the store's country rules do not cover, so the prefill books it
 *   on the Swedish accounts (crm#1032). First, since it outranks the rest.
 * - country_unknown: a Shopify order without a destination country in a
 *   store that has country rules (isDestinationUnknown), so the prefill uses
 *   the Swedish accounts without knowing where the goods went. The bulk
 *   sweep refuses the same order.
 * - zero_rate_foreign: a 0%-rate amount on an order with a known non-SE
 *   billing country. The prefill's 3004 (ruta 42) is only right for
 *   domestic momsfri sales; export/EU sales belong on 31xx/33xx accounts.
 * - foreign_vat: VAT charged on a non-SEK order. Swedish 2611-series output
 *   VAT may be wrong if the merchant is over the EU distance-selling
 *   threshold (OSS): the store's tax setup decides, the user must check. Not
 *   for a bucket a 'swedish' country rule books: the store has answered that
 *   question for it (Swedish VAT on EU sales, crm#1449).
 */
export function resolveBookingWarnings(
  order: RoutableOrder &
    Pick<WebshopOrder, 'currency' | 'total' | 'total_tax' | 'vat_breakdown' | 'customer_country'>,
  settings?: Pick<WebshopStoreSettings, 'country_account_rules'> | null,
): BookingWarning[] {
  // The same routing the prefill books from (routeOrder: the store's split,
  // or the ratio-inferred bucket when it sent none), so a hint never misses
  // a bucket the prefill shows. Buckets a country rule books on its own
  // accounts are not the Swedish prefill these hints are about.
  const routing = routeOrder(order, settings)
  const swedishBuckets = routing.buckets.filter(usesSwedishAccounts).map((route) => route.bucket)
  const defaultBuckets = routing.buckets.filter((route) => route.rule === null).map((route) => route.bucket)
  const warnings: BookingWarning[] = []
  if (routing.unroutedRates.length > 0) warnings.push('country_not_routed')
  if (routing.destinationUnknown) warnings.push('country_unknown')
  const hasZeroRateAmount = swedishBuckets.some(
    (b) => b.rate === 0 && b.net !== 0,
  )
  if (
    hasZeroRateAmount &&
    order.customer_country &&
    order.customer_country.toUpperCase() !== 'SE'
  ) {
    warnings.push('zero_rate_foreign')
  }
  // An order without the store's own split warns whatever its inferred
  // bucket routes to: the rate itself is a guess the user must check.
  if (
    order.currency.toUpperCase() !== 'SEK' &&
    order.total_tax !== 0 &&
    (order.vat_breakdown.length === 0 || defaultBuckets.some((b) => b.tax !== 0))
  ) {
    warnings.push('foreign_vat')
  }
  return warnings
}

/**
 * The default verifikat/line description for an order or refund row. Kept as
 * a single helper so the dialog prefill, the single-order route and the bulk
 * route all label the booking identically.
 */
export function orderBookingDescription(
  order: Pick<
    WebshopOrder,
    'row_type' | 'order_number' | 'payment_method' | 'payment_method_title'
  >,
): string {
  if (order.row_type === 'refund') {
    return `Återbetalning order ${order.order_number}`
  }
  const methodLabel = order.payment_method_title || order.payment_method || ''
  return methodLabel
    ? `Order ${order.order_number} (${methodLabel})`
    : `Order ${order.order_number}`
}

export interface OrderBookingLinesInput {
  order: Pick<
    WebshopOrder,
    | 'row_type'
    | 'order_number'
    | 'payment_method'
    | 'payment_method_title'
    | 'currency'
    | 'total'
    | 'total_tax'
    | 'total_sek'
    | 'exchange_rate'
    | 'vat_breakdown'
  > &
    RoutableOrder
  settings?: WebshopStoreSettings | null
  /** Explicit override of the payment counter-account (dialog edit). */
  paymentAccount?: string
  /**
   * Revenue template: revenue account per Swedish VAT rate. A rate not in
   * the map falls back to DEFAULT_REVENUE_ACCOUNT_BY_RATE. Only the revenue
   * side is templated; output VAT accounts are always derived from the rate.
   * Applies to buckets on the Swedish accounts only, never to one a country
   * rule books on its own accounts (usesRevenueTemplate): a 'swedish' rule's
   * own revenue account outranks it.
   */
  revenueAccounts?: Partial<Record<number, string>>
}

/**
 * The part of an order's gross total its VAT buckets do not cover, when it
 * is above MAX_RESIDUAL_SEK. amount is in SEK, positive when the gross is the
 * larger (in the refund's own direction for a refund row).
 * - booked 'shipping': the gross is the larger and every bucket books on one
 *   rate and one pair of accounts, so the gap is split at that rate onto
 *   those accounts, like shipping that follows the goods (a refund whose
 *   shipping part has no tax line, crm#1993). The lines balance.
 * - booked null: several rates, no bucket, or buckets above the gross. The
 *   lines leave the gap out and do not balance, so a person decides.
 */
export interface OrderBookingGap {
  amount: number
  booked: 'shipping' | null
}

export interface OrderBooking {
  lines: CreateJournalEntryLineInput[]
  /** null when the gross and the buckets agree within MAX_RESIDUAL_SEK. */
  gap: OrderBookingGap | null
}

/**
 * Build balanced prefill lines for one order/refund row. Throws if total_sek
 * is required but unresolved: callers gate on it first.
 */
export function buildOrderBookingLines(input: OrderBookingLinesInput): CreateJournalEntryLineInput[] {
  return buildOrderBooking(input).lines
}

/** buildOrderBookingLines() with the gap it could not book as öresavrundning. */
export function buildOrderBooking({
  order,
  settings,
  paymentAccount,
  revenueAccounts,
}: OrderBookingLinesInput): OrderBooking {
  const isSek = order.currency.toUpperCase() === 'SEK'
  const rate = isSek ? 1 : order.exchange_rate
  const grossSek = isSek ? round(order.total) : order.total_sek
  if (grossSek === null || grossSek === undefined || !rate) {
    throw new Error('Order is missing a resolved SEK amount; booking is blocked until the exchange rate resolves')
  }

  const account = paymentAccount ?? resolvePaymentAccount(order, settings).account
  // Refund rows carry negative totals; build everything from magnitudes and
  // apply direction at the end so debit/credit never go negative.
  const isRefund = order.row_type === 'refund'
  const grossAbs = round(Math.abs(grossSek))

  const routing = routeOrder(order, settings)

  const toSek = (amount: number) => sekOfForeign(Math.abs(amount), rate)

  const description = orderBookingDescription(order)

  const currencyMeta = (amountAbs: number): Partial<CreateJournalEntryLineInput> =>
    isSek
      ? {}
      : {
          currency: order.currency.toUpperCase(),
          amount_in_currency: amountAbs,
          exchange_rate: rate,
        }

  const line = (
    accountNumber: string,
    sekAbs: number,
    side: 'debit' | 'credit',
    originalAbs: number,
  ): CreateJournalEntryLineInput => ({
    account_number: accountNumber,
    debit_amount: side === 'debit' ? sekAbs : 0,
    credit_amount: side === 'credit' ? sekAbs : 0,
    line_description: description,
    ...currencyMeta(originalAbs),
  })

  // Order: money in (debit payment account); refund: money out (credit).
  const grossSide: 'debit' | 'credit' = isRefund ? 'credit' : 'debit'
  const counterSide: 'debit' | 'credit' = isRefund ? 'debit' : 'credit'

  const lines: CreateJournalEntryLineInput[] = [
    line(account, grossAbs, grossSide, round(Math.abs(order.total))),
  ]

  // Buckets are SIGNED: a discount/gift-card bucket carries a negative net
  // and must book on the OPPOSITE side (a revenue reduction), never as
  // abs-flipped extra revenue with the difference dumped on 3740 (skeptic
  // finding). counterSum accumulates the signed counter-direction total so
  // the residual stays a pure öre artifact.
  let counterSum = 0
  // The same total in the order currency, for a gap above the residual limit.
  let counterSumOriginal = 0
  const pushSigned = (account: string, signedOriginal: number) => {
    if (signedOriginal === 0) return
    counterSumOriginal = round(counterSumOriginal + signedOriginal)
    const amountAbs = round(Math.abs(signedOriginal))
    const sekAbs = toSek(amountAbs)
    if (sekAbs === 0) return
    const side = signedOriginal > 0 ? counterSide : grossSide
    lines.push(line(account, sekAbs, side, amountAbs))
    counterSum = round(counterSum + (signedOriginal > 0 ? sekAbs : -sekAbs))
  }
  // The rate and accounts of every bucket with an amount.
  const targets: Array<{ rate: number; revenueAccount: string; vatAccount: string | null }> = []
  for (const { bucket, rule } of routing.buckets) {
    const hasAmount = round(bucket.net) !== 0 || round(bucket.tax) !== 0
    if (rule && rule.mode === 'accounts') {
      pushSigned(rule.revenue_account, round(bucket.net))
      // routeOrderBuckets never routes a bucket with tax to a rule without
      // a VAT account, so a missing one here means the bucket has no tax.
      if (rule.vat_account) pushSigned(rule.vat_account, round(bucket.tax))
      if (hasAmount) {
        targets.push({ rate: bucket.rate, revenueAccount: rule.revenue_account, vatAccount: rule.vat_account })
      }
      continue
    }
    // A 'swedish' rule may name the revenue account (Swedish VAT on EU sales
    // on an account of their own, crm#1449); the VAT account follows the rate.
    const ruleRevenueAccount = rule?.mode === 'swedish' ? rule.revenue_account : null
    const revenueAccount =
      ruleRevenueAccount ||
      (revenueAccounts?.[bucket.rate] ??
        REVENUE_ACCOUNT_BY_RATE[bucket.rate] ??
        REVENUE_ACCOUNT_BY_RATE[25])
    const vatAccount = VAT_ACCOUNT_BY_RATE[bucket.rate] ?? VAT_ACCOUNT_BY_RATE[25]
    pushSigned(revenueAccount, round(bucket.net))
    pushSigned(vatAccount, round(bucket.tax))
    if (hasAmount) targets.push({ rate: bucket.rate, revenueAccount, vatAccount })
  }

  // A gap above the residual limit is not öresavrundning (OrderBookingGap):
  // split at the order's one rate when the gross is the larger, else left
  // out for a person to book.
  let gap: OrderBookingGap | null = null
  const bucketGap = round(grossAbs - counterSum)
  if (Math.abs(bucketGap) > MAX_RESIDUAL_SEK) {
    const [first] = targets
    const oneTarget =
      first &&
      targets.every(
        (t) => t.rate === first.rate && t.revenueAccount === first.revenueAccount && t.vatAccount === first.vatAccount,
      )
        ? first
        : null
    const gapOriginal = round(Math.abs(order.total) - counterSumOriginal)
    if (bucketGap > 0 && gapOriginal > 0 && oneTarget && (oneTarget.vatAccount || oneTarget.rate <= 0)) {
      const { vat, net } = splitGrossVat(gapOriginal, oneTarget.rate / 100)
      pushSigned(oneTarget.revenueAccount, net)
      if (oneTarget.vatAccount) pushSigned(oneTarget.vatAccount, vat)
      gap = { amount: bucketGap, booked: 'shipping' }
    } else {
      gap = { amount: bucketGap, booked: null }
    }
  }

  // Balance residual (per-line rounding, FX drift) to öresavrundning, only
  // within the limit. The residual can fall on either side. No currency
  // metadata: the residual is an SEK-conversion artifact, not an amount that
  // exists in the order currency.
  const residual = round(grossAbs - counterSum)
  // A split the SEK conversion leaves unbalanced beyond the limit is not booked.
  if (gap && Math.abs(residual) > MAX_RESIDUAL_SEK) gap = { amount: gap.amount, booked: null }
  if (residual !== 0 && Math.abs(residual) <= MAX_RESIDUAL_SEK) {
    const side: 'debit' | 'credit' = residual > 0 ? counterSide : grossSide
    const residualAbs = round(Math.abs(residual))
    lines.push({
      account_number: ROUNDING_ACCOUNT,
      debit_amount: side === 'debit' ? residualAbs : 0,
      credit_amount: side === 'credit' ? residualAbs : 0,
      line_description: description,
    })
  }

  return { lines, gap }
}
