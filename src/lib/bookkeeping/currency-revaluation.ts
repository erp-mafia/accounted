import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import {
  fetchPaymentsAsOf,
  outstandingAsOf,
  todayIsoDate,
  type PaymentsAsOf,
} from '@/lib/reports/reskontra-payments'
import {
  BookkeepingDatabaseError,
  CurrencyRevaluationAlreadyExistsError,
} from '@/lib/bookkeeping/errors'
import type {
  Currency,
  Invoice,
  SupplierInvoice,
  RevaluationItem,
  CurrencyRevaluationPreview,
  CurrencyRevaluationResult,
  CreateJournalEntryLineInput,
} from '@/types'

export const FX_CLOSING_RATE_UNAVAILABLE = 'FX_CLOSING_RATE_UNAVAILABLE' as const

/** A currency whose balansdagen rate could not be established. */
export interface MissingClosingRate {
  currency: Currency
  date: string
}

/**
 * Raised when the revaluation would have to invent a closing rate.
 *
 * The balansdagen valuation of monetary items (ÅRL 4 kap. 13 §) posts a real
 * verifikat to 3960/7960, so the rate behind it must be a real Riksbanken
 * observation. `code` is in the structured-error registry, so REST routes and
 * MCP tools translate it without any per-caller handling.
 */
export class ClosingRateUnavailableError extends Error {
  readonly code = FX_CLOSING_RATE_UNAVAILABLE
  constructor(public readonly missingRates: MissingClosingRate[]) {
    super(
      `No Riksbanken exchange rate available for ${missingRates
        .map((m) => `${m.currency} on ${m.date}`)
        .join(', ')}: currency revaluation refused rather than posted from an estimated rate.`
    )
    this.name = 'ClosingRateUnavailableError'
  }
}

/** An open foreign-currency row that carries no exchange rate at all. */
export interface UnconvertedFxItem {
  type: 'receivable' | 'payable'
  source_id: string
  reference: string
  currency: Currency
  amount_in_currency: number
}

/**
 * Preview plus the two exclusion channels a caller must be able to show:
 * rows that carry no original rate, and currencies with no closing rate.
 * Same shape of contract as `unconverted_fx_count` on the reskontra reports.
 */
export interface CurrencyRevaluationPreviewWithExclusions extends CurrencyRevaluationPreview {
  /**
   * Open foreign-currency rows excluded because they have no `exchange_rate`
   * on file. They cannot be revalued (there is no original SEK value to
   * compare against) and they are usually the largest unmeasured exposure, so
   * they are counted and returned instead of silently dropped.
   */
  unconvertedFx: UnconvertedFxItem[]
  unconvertedFxCount: number
  /** Currencies with no Riksbanken observation for the closing date. */
  missingClosingRates: MissingClosingRate[]
}

export interface CurrencyRevaluationResultWithExclusions extends CurrencyRevaluationResult {
  preview: CurrencyRevaluationPreviewWithExclusions
}

/** A stored rate is usable only when present and strictly positive. */
function hasUsableRate(rate: number | null | undefined): boolean {
  return rate != null && Number(rate) > 0
}

/**
 * Which invoice rows can carry balance-sheet FX exposure for this company.
 *
 * ÅRL 4 kap. 13 § revalues MONETARY ITEMS ON THE BALANCE SHEET, and an invoice
 * row only puts anything on 1510/2440 once its registration is booked. Under
 * #967 "Registrera men bokför inte" (and under kontantmetoden) a registered
 * invoice can sit in the reskontra with nothing on the balance sheet at all;
 * revaluing those fabricated a write-down of an account standing at zero.
 *
 * NOT keyed on accounting_method: kontantmetoden companies must still book
 * their outstanding fordringar/skulder at balansdagen (BFL 5 kap 2 § 3 st), and
 * those year-end-converted rows are genuine FX exposure that has to be valued.
 * The predicate is therefore per row ("is this one booked?"), never per company
 * ("does this company use the cash method?"):
 * - 'booked_only': only rows carrying a registration entry are on the balance
 *   sheet (kontantmetoden, or faktureringsmetoden with defer_invoice_booking)
 * - 'all': inline booking at issue, the historical default. Every open row is
 *   booked, including legacy/SIE-imported rows that predate the entry links,
 *   so requiring a link there would silently drop real exposure.
 */
export type FxExposureScope = 'all' | 'booked_only'

export function fxExposureScope(
  settings:
    | { accounting_method?: string | null; defer_invoice_booking?: boolean | null }
    | null
    | undefined
): FxExposureScope {
  // No settings row: historical default (accrual, book at issue).
  if (!settings) return 'all'
  if ((settings.accounting_method || 'accrual') !== 'accrual') return 'booked_only'
  return settings.defer_invoice_booking ? 'booked_only' : 'all'
}

/**
 * Never throws: `previewCurrencyRevaluation` is the read-only surface and the
 * year-end preview must still render (same contract as the missing-rate path).
 * A settings row that cannot be read falls back to the historical default,
 * which is also what a missing row means.
 */
export async function fetchFxExposureScope(
  supabase: SupabaseClient,
  companyId: string
): Promise<FxExposureScope> {
  const { data, error } = await supabase
    .from('company_settings')
    .select('accounting_method, defer_invoice_booking')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) return 'all'
  return fxExposureScope(data)
}

/**
 * Fetch open foreign-currency receivables (invoices).
 * Returns invoices with status 'sent', 'overdue' or 'partially_paid' and
 * non-SEK currency, INCLUDING ones with no `exchange_rate`: filtering those
 * out in SQL hid the largest unmeasured FX exposure from the caller. The
 * caller partitions them and reports the excluded rows.
 *
 * 'partially_paid' belongs in the list: payment-sync moves a customer invoice
 * to that status on a partial settlement, and its unpaid remainder is still a
 * monetary item that ÅRL 4 kap. 13 § values at balansdagen. Omitting it made
 * partially paid foreign receivables entirely invisible to the revaluation
 * (the payables side has always included it).
 *
 * When `asOfDate` is given the population is measured AS OF that date, not as
 * of now. Two independent adjustments:
 * - the date ceiling (`invoice_date <= asOfDate`) is UNCONDITIONAL: an invoice
 *   issued after the balансdagen was not on the balance sheet being valued,
 *   whether or not that date happens to be in the past. Post-dated invoices
 *   make this reachable for a current period too.
 * - the status widening to 'paid' applies only to a historical date, where an
 *   invoice settled since (in March, say) was still open on 31 December. For
 *   today or the future the stored open state IS the as-of state.
 * The caller recomputes each row's outstanding from the payment history (see
 * previewCurrencyRevaluation). Same reconstruction contract as
 * countOpenFxItemsAtBalansdagen in year-end-service and the reskontra reports.
 */
export async function getOpenForeignCurrencyReceivables(
  supabase: SupabaseClient,
  companyId: string,
  asOfDate?: string
): Promise<Invoice[]> {
  const historical = asOfDate != null && asOfDate < todayIsoDate()
  try {
    // Paginated with a stable id order so a company with >1000 open FX invoices
    // is fully revalued rather than silently truncated at 1000 rows.
    return await fetchAllRows<Invoice>(({ from, to }) => {
      const base = supabase
        .from('invoices')
        .select('*')
        .eq('company_id', companyId)
        // Proformas, delivery notes and quotes are never receivables: they
        // sit on no 1510 balance, so there is nothing to revalue.
        .eq('document_type', 'invoice')
        .neq('currency', 'SEK')
        .in(
          'status',
          historical
            ? ['sent', 'overdue', 'partially_paid', 'paid']
            : ['sent', 'overdue', 'partially_paid']
        )
      const scoped = asOfDate != null ? base.lte('invoice_date', asOfDate) : base
      return scoped.order('id', { ascending: true }).range(from, to)
    }, { dedupeBy: (i) => i.id })
  } catch (err) {
    throw new BookkeepingDatabaseError(
      'fetch_currency_receivables',
      err instanceof Error ? err.message : 'fetch failed'
    )
  }
}

/**
 * Fetch open foreign-currency payables (supplier invoices).
 * Returns supplier invoices with open statuses and non-SEK currency,
 * INCLUDING ones with no `exchange_rate` (see the receivables note above).
 * Uses remaining_amount for partial payments.
 *
 * `asOfDate` behaves as on the receivables side: the date ceiling is
 * unconditional, the widening to 'paid' applies only to a historical date.
 */
export async function getOpenForeignCurrencyPayables(
  supabase: SupabaseClient,
  companyId: string,
  asOfDate?: string
): Promise<SupplierInvoice[]> {
  const historical = asOfDate != null && asOfDate < todayIsoDate()
  try {
    // Paginated with a stable id order so a company with >1000 open FX payables
    // is fully revalued rather than silently truncated at 1000 rows.
    return await fetchAllRows<SupplierInvoice>(({ from, to }) => {
      const base = supabase
        .from('supplier_invoices')
        .select('*')
        .eq('company_id', companyId)
        .neq('currency', 'SEK')
        .in(
          'status',
          historical
            ? ['registered', 'approved', 'overdue', 'partially_paid', 'paid']
            : ['registered', 'approved', 'overdue', 'partially_paid']
        )
      const scoped = asOfDate != null ? base.lte('invoice_date', asOfDate) : base
      return scoped.order('id', { ascending: true }).range(from, to)
    }, { dedupeBy: (i) => i.id })
  } catch (err) {
    throw new BookkeepingDatabaseError(
      'fetch_currency_payables',
      err instanceof Error ? err.message : 'fetch failed'
    )
  }
}

/**
 * Preview currency revaluation without persisting.
 * Computes per-item differences and aggregated journal lines.
 *
 * Receivables (1510):
 *   closing > original → gain: Debit 1510, Credit 3960
 *   closing < original → loss: Credit 1510, Debit 7960
 *
 * Payables (2440):
 *   closing > original → loss (liability grew): Debit 7960, Credit 2440
 *   closing < original → gain (liability shrank): Debit 2440, Credit 3960
 *
 * Never throws on a missing rate: this is the read-only surface, and the
 * year-end preview must still render. Both exclusion channels come back on
 * the result (`unconvertedFx*`, `missingClosingRates`) so the caller can show
 * them. `executeCurrencyRevaluation` is what refuses to post.
 */
export async function previewCurrencyRevaluation(
  supabase: SupabaseClient,
  companyId: string,
  closingDate: string
): Promise<CurrencyRevaluationPreviewWithExclusions> {
  const emptyPreview: CurrencyRevaluationPreviewWithExclusions = {
    items: [],
    lines: [],
    closingRates: {},
    totalGain: 0,
    totalLoss: 0,
    netEffect: 0,
    unconvertedFx: [],
    unconvertedFxCount: 0,
    missingClosingRates: [],
  }

  const scope = await fetchFxExposureScope(supabase, companyId)

  const [receivables, payables] = await Promise.all([
    getOpenForeignCurrencyReceivables(supabase, companyId, closingDate),
    getOpenForeignCurrencyPayables(supabase, companyId, closingDate),
  ])

  // For a historical balansdagen the live status/paid_amount columns describe
  // today, not the balance sheet being valued: reconstruct each row's
  // outstanding from the payment history, the same walk-back the reskontra
  // reports and countOpenFxItemsAtBalansdagen use.
  const isHistorical = closingDate < todayIsoDate()
  const [receivablePayments, payablePayments]: [PaymentsAsOf | null, PaymentsAsOf | null] =
    await Promise.all([
      isHistorical && receivables.length > 0
        ? fetchPaymentsAsOf(supabase, 'invoice_payments', 'invoice_id', companyId, closingDate)
        : null,
      isHistorical && payables.length > 0
        ? fetchPaymentsAsOf(
            supabase,
            'supplier_invoice_payments',
            'supplier_invoice_id',
            companyId,
            closingDate
          )
        : null,
    ])

  // Partition into rows we can revalue and rows with no original rate, and
  // collect the distinct currencies of the revaluable rows.
  const currencies = new Set<Currency>()
  const unconvertedFx: UnconvertedFxItem[] = []
  const revaluableReceivables: Array<{ inv: Invoice; outstanding: number }> = []
  const revaluablePayables: Array<{ si: SupplierInvoice; outstanding: number }> = []

  for (const inv of receivables) {
    // Deferred booking: an unbooked registration is not on 1510, so it is not
    // a monetary item to revalue (nor unmeasured exposure to report).
    if (scope === 'booked_only' && !inv.journal_entry_id) continue
    // Only the OUTSTANDING amount is a monetary item at balansdagen: the paid
    // part has already been settled at its own realized rate. Kundreskontran
    // derives outstanding from total - paid_amount (see year-end-service),
    // so the same definition is used here, öre-rounded.
    const total = Number(inv.total) || 0
    const live = Math.round((total - (Number(inv.paid_amount) || 0)) * 100) / 100
    const outstanding = receivablePayments
      ? outstandingAsOf(inv, total, live, receivablePayments, closingDate)
      : live
    // Nothing outstanding on balansdagen: nothing to revalue, no exposure.
    if (outstanding <= 0) continue
    if (!hasUsableRate(inv.exchange_rate)) {
      unconvertedFx.push({
        type: 'receivable',
        source_id: inv.id,
        reference: inv.invoice_number ?? '',
        currency: inv.currency,
        amount_in_currency: outstanding,
      })
      continue
    }
    currencies.add(inv.currency)
    revaluableReceivables.push({ inv, outstanding })
  }

  for (const si of payables) {
    // See the receivables note: unbooked registrations carry no 2440 balance.
    if (scope === 'booked_only' && !si.registration_journal_entry_id) continue
    const total = Number(si.total) || 0
    const live = Number(si.remaining_amount) || 0
    const outstanding = payablePayments
      ? outstandingAsOf(si, total, live, payablePayments, closingDate)
      : live
    // Nothing outstanding on balansdagen: nothing to revalue, no exposure.
    if (outstanding <= 0) continue
    if (!hasUsableRate(si.exchange_rate)) {
      unconvertedFx.push({
        type: 'payable',
        source_id: si.id,
        reference: si.supplier_invoice_number,
        currency: si.currency as Currency,
        amount_in_currency: outstanding,
      })
      continue
    }
    currencies.add(si.currency as Currency)
    revaluablePayables.push({ si, outstanding })
  }

  if (currencies.size === 0) {
    return { ...emptyPreview, unconvertedFx, unconvertedFxCount: unconvertedFx.length }
  }

  // Fetch closing rates one currency at a time through fetchExchangeRate: it
  // is the documented booking path and returns null rather than one of the
  // hardcoded display-only constants in getFallbackRate(). fetchMultipleRates
  // pads its Map with those constants to keep a fully-populated-Map contract,
  // which is fine for a rate widget and unacceptable for a verifikat: this
  // function's output is posted to 3960/7960. Passing `supabase` uses the
  // shared exchange_rates cache, so a balansdagen rate stays reproducible.
  const currencyList = Array.from(currencies)
  const fetched = await Promise.all(
    currencyList.map((currency) => fetchExchangeRate(currency, new Date(closingDate), supabase))
  )

  const rateMap = new Map<Currency, number>()
  const missingClosingRates: MissingClosingRate[] = []
  for (let i = 0; i < currencyList.length; i++) {
    const observed = fetched[i]
    if (observed && Number.isFinite(observed.rate) && observed.rate > 0) {
      rateMap.set(currencyList[i], observed.rate)
    } else {
      missingClosingRates.push({ currency: currencyList[i], date: closingDate })
    }
  }

  const closingRates: Record<string, number> = {}
  for (const [currency, rate] of rateMap) {
    closingRates[currency] = rate
  }

  const items: RevaluationItem[] = []

  // Process receivables (use the outstanding amount for partial payments,
  // mirroring the payables' remaining_amount below)
  for (const { inv, outstanding } of revaluableReceivables) {
    const closingRate = rateMap.get(inv.currency)
    if (!closingRate || !inv.exchange_rate) continue

    const amountInCurrency = outstanding
    const originalSek = Math.round(amountInCurrency * inv.exchange_rate * 100) / 100
    const closingSek = Math.round(amountInCurrency * closingRate * 100) / 100
    const difference = Math.round((closingSek - originalSek) * 100) / 100

    if (Math.abs(difference) < 0.01) continue

    items.push({
      type: 'receivable',
      source_id: inv.id,
      reference: inv.invoice_number ?? '',
      currency: inv.currency,
      amount_in_currency: amountInCurrency,
      original_rate: inv.exchange_rate,
      closing_rate: closingRate,
      original_sek: originalSek,
      closing_sek: closingSek,
      difference_sek: difference,
    })
  }

  // Process payables (outstanding as of balansdagen, mirroring receivables)
  for (const { si, outstanding } of revaluablePayables) {
    const closingRate = rateMap.get(si.currency as Currency)
    if (!closingRate || !si.exchange_rate) continue

    const amountInCurrency = outstanding

    const originalSek = Math.round(amountInCurrency * si.exchange_rate * 100) / 100
    const closingSek = Math.round(amountInCurrency * closingRate * 100) / 100
    const difference = Math.round((closingSek - originalSek) * 100) / 100

    if (Math.abs(difference) < 0.01) continue

    items.push({
      type: 'payable',
      source_id: si.id,
      reference: si.supplier_invoice_number,
      currency: si.currency as Currency,
      amount_in_currency: amountInCurrency,
      original_rate: si.exchange_rate,
      closing_rate: closingRate,
      original_sek: originalSek,
      closing_sek: closingSek,
      difference_sek: difference,
    })
  }

  // Build aggregated journal lines
  let debit1510 = 0 // Receivable gain (revalue up)
  let credit1510 = 0 // Receivable loss (revalue down)
  let debit2440 = 0 // Payable gain (liability shrank)
  let credit2440 = 0 // Payable loss (liability grew)
  let credit3960 = 0 // Gains
  let debit7960 = 0 // Losses

  for (const item of items) {
    if (item.type === 'receivable') {
      if (item.difference_sek > 0) {
        // Closing > original → gain: Debit 1510, Credit 3960
        debit1510 += item.difference_sek
        credit3960 += item.difference_sek
      } else {
        // Closing < original → loss: Credit 1510, Debit 7960
        credit1510 += Math.abs(item.difference_sek)
        debit7960 += Math.abs(item.difference_sek)
      }
    } else {
      // Payable
      if (item.difference_sek > 0) {
        // Closing > original → loss (liability grew): Debit 7960, Credit 2440
        debit7960 += item.difference_sek
        credit2440 += item.difference_sek
      } else {
        // Closing < original → gain (liability shrank): Debit 2440, Credit 3960
        debit2440 += Math.abs(item.difference_sek)
        credit3960 += Math.abs(item.difference_sek)
      }
    }
  }

  const lines: CreateJournalEntryLineInput[] = []

  if (debit1510 > 0) {
    lines.push({
      account_number: '1510',
      debit_amount: Math.round(debit1510 * 100) / 100,
      credit_amount: 0,
      line_description: 'Omvärdering kundfordringar: orealiserad kursvinst',
    })
  }
  if (credit1510 > 0) {
    lines.push({
      account_number: '1510',
      debit_amount: 0,
      credit_amount: Math.round(credit1510 * 100) / 100,
      line_description: 'Omvärdering kundfordringar: orealiserad kursförlust',
    })
  }
  if (debit2440 > 0) {
    lines.push({
      account_number: '2440',
      debit_amount: Math.round(debit2440 * 100) / 100,
      credit_amount: 0,
      line_description: 'Omvärdering leverantörsskulder: orealiserad kursvinst',
    })
  }
  if (credit2440 > 0) {
    lines.push({
      account_number: '2440',
      debit_amount: 0,
      credit_amount: Math.round(credit2440 * 100) / 100,
      line_description: 'Omvärdering leverantörsskulder: orealiserad kursförlust',
    })
  }
  if (credit3960 > 0) {
    lines.push({
      account_number: '3960',
      debit_amount: 0,
      credit_amount: Math.round(credit3960 * 100) / 100,
      line_description: 'Orealiserade valutakursvinster',
    })
  }
  if (debit7960 > 0) {
    lines.push({
      account_number: '7960',
      debit_amount: Math.round(debit7960 * 100) / 100,
      credit_amount: 0,
      line_description: 'Orealiserade valutakursförluster',
    })
  }

  const totalGain = Math.round(credit3960 * 100) / 100
  const totalLoss = Math.round(debit7960 * 100) / 100
  const netEffect = Math.round((totalGain - totalLoss) * 100) / 100

  return {
    items,
    lines,
    closingRates,
    totalGain,
    totalLoss,
    netEffect,
    unconvertedFx,
    unconvertedFxCount: unconvertedFx.length,
    missingClosingRates,
  }
}

/**
 * Execute currency revaluation for a fiscal period.
 * Creates a journal entry with source_type 'currency_revaluation'.
 *
 * Returns null if no foreign-currency items exist.
 * Throws if a revaluation entry already exists for this period (idempotency).
 * Throws ClosingRateUnavailableError if any required balansdagen rate is
 * missing: this entry must never be computed from an estimated rate.
 */
export async function executeCurrencyRevaluation(
  supabase: SupabaseClient,
  companyId: string,
  closingDate: string,
  fiscalPeriodId: string,
  userId?: string
): Promise<CurrencyRevaluationResultWithExclusions | null> {
  // Idempotency check: prevent double revaluation
  const { count, error: checkError } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .eq('source_type', 'currency_revaluation')
    .eq('status', 'posted')

  if (checkError) {
    throw new BookkeepingDatabaseError('check_existing_revaluation', checkError.message)
  }

  if ((count ?? 0) > 0) {
    throw new CurrencyRevaluationAlreadyExistsError()
  }

  const preview = await previewCurrencyRevaluation(supabase, companyId, closingDate)

  // Refuse before anything is posted. Checked ahead of the empty-preview
  // shortcut on purpose: when every currency lacks a closing rate the item
  // list is also empty, and returning null there would report "nothing to
  // revalue" for what is really "we could not value it". A partial post is
  // refused too: it would understate the FX result on 3960/7960 while looking
  // like a complete balansdagen valuation (ÅRL 4 kap. 13 §).
  if (preview.missingClosingRates.length > 0) {
    throw new ClosingRateUnavailableError(preview.missingClosingRates)
  }

  if (preview.items.length === 0 || preview.lines.length === 0) {
    return null
  }

  const entry = await createJournalEntry(supabase, companyId, userId ?? companyId, {
    fiscal_period_id: fiscalPeriodId,
    entry_date: closingDate,
    description: `Omvärdering utländsk valuta ${closingDate}`,
    source_type: 'currency_revaluation',
    voucher_series: 'A',
    lines: preview.lines,
  })

  return { entry, preview }
}
