import { roundOre as round } from '@/lib/money'
import type {
  CreateJournalEntryLineInput,
  WebshopOrder,
  WebshopStoreSettings,
  WebshopVatBreakdownLine,
} from '@/types'

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
 * A rounding residual goes to 3740 Öresavrundning so the entry balances.
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
/** BAS 2026 name for DEFAULT_PAYMENT_ACCOUNT; used when adding it to a chart. */
export const DEFAULT_PAYMENT_ACCOUNT_NAME = 'Fordringar för kontokort och kuponger'

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
 * Resolve the prefilled payment counter-account for an order from the
 * per-store mapping. Returns the account plus whether the store marked this
 * payment method as invoice-flow (the dialog then nudges toward Skapa
 * faktura instead).
 */
export function resolvePaymentAccount(
  order: Pick<WebshopOrder, 'payment_method'>,
  settings: WebshopStoreSettings | null | undefined,
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

export type BookingWarning = 'zero_rate_foreign' | 'foreign_vat'

/**
 * Advisory (never blocking, per the soft-guard rule) compliance hints for
 * the booking dialog:
 * - zero_rate_foreign: a 0%-rate amount on an order with a known non-SE
 *   billing country. The prefill's 3004 (ruta 42) is only right for
 *   domestic momsfri sales; export/EU sales belong on 31xx/33xx accounts.
 * - foreign_vat: VAT charged on a non-SEK order. Swedish 2611-series output
 *   VAT may be wrong if the merchant is over the EU distance-selling
 *   threshold (OSS) — the store's tax setup decides, the user must check.
 */
export function resolveBookingWarnings(
  order: Pick<
    WebshopOrder,
    'currency' | 'total_tax' | 'vat_breakdown' | 'customer_country'
  >,
): BookingWarning[] {
  const warnings: BookingWarning[] = []
  const hasZeroRateAmount = order.vat_breakdown.some(
    (b) => b.rate === 0 && b.net !== 0,
  )
  if (
    hasZeroRateAmount &&
    order.customer_country &&
    order.customer_country.toUpperCase() !== 'SE'
  ) {
    warnings.push('zero_rate_foreign')
  }
  if (order.currency.toUpperCase() !== 'SEK' && order.total_tax !== 0) {
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
  >
  settings?: WebshopStoreSettings | null
  /** Explicit override of the payment counter-account (dialog edit). */
  paymentAccount?: string
  /**
   * Revenue template: revenue account per Swedish VAT rate. A rate not in
   * the map falls back to DEFAULT_REVENUE_ACCOUNT_BY_RATE. Only the revenue
   * side is templated; output VAT accounts are always derived from the rate.
   */
  revenueAccounts?: Partial<Record<number, string>>
}

/**
 * Build balanced prefill lines for one order/refund row. Throws if total_sek
 * is required but unresolved: callers gate on it first.
 */
export function buildOrderBookingLines({
  order,
  settings,
  paymentAccount,
  revenueAccounts,
}: OrderBookingLinesInput): CreateJournalEntryLineInput[] {
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

  const breakdown =
    order.vat_breakdown.length > 0
      ? order.vat_breakdown
      : fallbackVatBreakdown(order.total, order.total_tax)

  const toSek = (amount: number) => round(Math.abs(amount) * rate)

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
  const pushSigned = (account: string, signedOriginal: number) => {
    if (signedOriginal === 0) return
    const amountAbs = round(Math.abs(signedOriginal))
    const sekAbs = toSek(amountAbs)
    if (sekAbs === 0) return
    const side = signedOriginal > 0 ? counterSide : grossSide
    lines.push(line(account, sekAbs, side, amountAbs))
    counterSum = round(counterSum + (signedOriginal > 0 ? sekAbs : -sekAbs))
  }
  for (const bucket of breakdown) {
    const revenueAccount =
      revenueAccounts?.[bucket.rate] ??
      REVENUE_ACCOUNT_BY_RATE[bucket.rate] ??
      REVENUE_ACCOUNT_BY_RATE[25]
    const vatAccount = VAT_ACCOUNT_BY_RATE[bucket.rate] ?? VAT_ACCOUNT_BY_RATE[25]
    pushSigned(revenueAccount, round(bucket.net))
    pushSigned(vatAccount, round(bucket.tax))
  }

  // Balance residual (per-line rounding, FX drift) to öresavrundning. The
  // residual can fall on either side. No currency metadata: the residual is
  // an SEK-conversion artifact, not an amount that exists in the order
  // currency.
  const residual = round(grossAbs - counterSum)
  if (residual !== 0) {
    const side: 'debit' | 'credit' = residual > 0 ? counterSide : grossSide
    const residualAbs = round(Math.abs(residual))
    lines.push({
      account_number: ROUNDING_ACCOUNT,
      debit_amount: side === 'debit' ? residualAbs : 0,
      credit_amount: side === 'credit' ? residualAbs : 0,
      line_description: description,
    })
  }

  return lines
}
