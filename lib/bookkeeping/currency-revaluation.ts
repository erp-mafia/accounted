import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchMultipleRates } from '@/lib/currency/riksbanken'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
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

/**
 * Fetch open foreign-currency receivables (invoices).
 * Returns invoices with status 'sent' or 'overdue', non-SEK currency,
 * and a known exchange rate.
 */
export async function getOpenForeignCurrencyReceivables(
  supabase: SupabaseClient,
  companyId: string
): Promise<Invoice[]> {
  try {
    // Paginated with a stable id order so a company with >1000 open FX invoices
    // is fully revalued rather than silently truncated at 1000 rows.
    return await fetchAllRows<Invoice>(({ from, to }) =>
      supabase
        .from('invoices')
        .select('*')
        .eq('company_id', companyId)
        .in('status', ['sent', 'overdue'])
        .neq('currency', 'SEK')
        .not('exchange_rate', 'is', null)
        .order('id', { ascending: true })
        .range(from, to)
    , { dedupeBy: (i) => i.id })
  } catch (err) {
    throw new BookkeepingDatabaseError(
      'fetch_currency_receivables',
      err instanceof Error ? err.message : 'fetch failed'
    )
  }
}

/**
 * Fetch open foreign-currency payables (supplier invoices).
 * Returns supplier invoices with open statuses, non-SEK currency,
 * and a known exchange rate. Uses remaining_amount for partial payments.
 */
export async function getOpenForeignCurrencyPayables(
  supabase: SupabaseClient,
  companyId: string
): Promise<SupplierInvoice[]> {
  try {
    // Paginated with a stable id order so a company with >1000 open FX payables
    // is fully revalued rather than silently truncated at 1000 rows.
    return await fetchAllRows<SupplierInvoice>(({ from, to }) =>
      supabase
        .from('supplier_invoices')
        .select('*')
        .eq('company_id', companyId)
        .in('status', ['registered', 'approved', 'overdue', 'partially_paid'])
        .neq('currency', 'SEK')
        .not('exchange_rate', 'is', null)
        .order('id', { ascending: true })
        .range(from, to)
    , { dedupeBy: (i) => i.id })
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
 */
export async function previewCurrencyRevaluation(
  supabase: SupabaseClient,
  companyId: string,
  closingDate: string
): Promise<CurrencyRevaluationPreview> {
  const [receivables, payables] = await Promise.all([
    getOpenForeignCurrencyReceivables(supabase, companyId),
    getOpenForeignCurrencyPayables(supabase, companyId),
  ])

  // Collect distinct currencies
  const currencies = new Set<Currency>()
  for (const inv of receivables) {
    currencies.add(inv.currency)
  }
  for (const si of payables) {
    currencies.add(si.currency as Currency)
  }

  if (currencies.size === 0) {
    return {
      items: [],
      lines: [],
      closingRates: {},
      totalGain: 0,
      totalLoss: 0,
      netEffect: 0,
    }
  }

  // Fetch closing rates
  const rateMap = await fetchMultipleRates(
    Array.from(currencies),
    new Date(closingDate)
  )

  const closingRates: Record<string, number> = {}
  for (const [currency, rate] of rateMap) {
    closingRates[currency] = rate.rate
  }

  const items: RevaluationItem[] = []

  // Process receivables
  for (const inv of receivables) {
    const closingRate = rateMap.get(inv.currency)?.rate
    if (!closingRate || !inv.exchange_rate) continue

    const amountInCurrency = inv.total
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

  // Process payables (use remaining_amount for partial payments)
  for (const si of payables) {
    const closingRate = rateMap.get(si.currency as Currency)?.rate
    if (!closingRate || !si.exchange_rate) continue

    const amountInCurrency = si.remaining_amount
    if (amountInCurrency <= 0) continue

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
  }
}

/**
 * Execute currency revaluation for a fiscal period.
 * Creates a journal entry with source_type 'currency_revaluation'.
 *
 * Returns null if no foreign-currency items exist.
 * Throws if a revaluation entry already exists for this period (idempotency).
 */
export async function executeCurrencyRevaluation(
  supabase: SupabaseClient,
  companyId: string,
  closingDate: string,
  fiscalPeriodId: string,
  userId?: string
): Promise<CurrencyRevaluationResult | null> {
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
