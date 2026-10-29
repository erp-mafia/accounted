import type { SupabaseClient } from '@supabase/supabase-js'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import { postingEvidence } from '@/lib/core/bookkeeping/year-end-business-events'
import { linkBasisColumns } from '@/lib/links/stamp'
import { createLogger } from '@/lib/logger'
import { sumOre } from '@/lib/money'
import { mappingVersion } from '@/lib/posting/mapping-version'
import { postingPort } from '@/lib/posting/port'
import type { BusinessEventDraft } from '@/lib/posting/types'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import type { JournalEntry } from '@/types'
import { StockCountError, stockCountErrorFromDb } from './errors'
import { buildStockCountView, loadStockCountRecord, loadStockCountRows, type StockCountRecord } from './register'
import {
  STOCK_CATEGORIES,
  STOCK_CATEGORY_ACCOUNTS,
  stockAdjustmentLines,
  stockAdjustments,
  type StockAdjustment,
  type StockAdjustmentLine,
} from './valuation'

const log = createLogger('bokslut/stock-count/booking')

/**
 * The lagerförändring on balansdagen: the counted value per kind of stock
 * against what the ledger holds on its accounts at the end of the fiscal
 * year, the difference booked on the stock account against its förändring
 * account (BAS 14xx against 49xx) as one bokslut verifikat through the
 * posting port. The engine draws the number and the period lock and the
 * balance trigger apply: a closed or locked year refuses, with its own
 * Swedish error. Only a signed count is booked, once per fiscal year.
 */

export interface StockCountBookingPreview {
  inventory_count_id: string
  fiscal_period_id: string
  balance_date: string
  counted_total: number
  ledger_total: number
  adjustments: StockAdjustment[]
  lines: StockAdjustmentLine[]
}

/** The stock accounts' closing balances for the fiscal year (debit positive). */
export async function fetchStockLedgerBalances(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<Record<string, number>> {
  const accounts = new Set(STOCK_CATEGORIES.flatMap((c) => STOCK_CATEGORY_ACCOUNTS[c].ledger))
  const { rows } = await generateTrialBalance(supabase, companyId, fiscalPeriodId, { closingEntry: 'include' })
  const balances: Record<string, number> = {}
  for (const row of rows) {
    if (!accounts.has(row.account_number)) continue
    balances[row.account_number] = (row.closing_debit || 0) - (row.closing_credit || 0)
  }
  return balances
}

export async function previewStockCountBooking(
  supabase: SupabaseClient,
  companyId: string,
  id: string,
  loaded?: { record: StockCountRecord },
): Promise<StockCountBookingPreview> {
  const record = loaded?.record ?? (await loadStockCountRecord(supabase, companyId, id))
  const view = buildStockCountView(record, await loadStockCountRows(supabase, companyId, record.id))
  const balances = await fetchStockLedgerBalances(supabase, companyId, record.fiscal_period_id)
  const adjustments = stockAdjustments(view.totals, balances)
  return {
    inventory_count_id: record.id,
    fiscal_period_id: record.fiscal_period_id,
    balance_date: record.balance_date,
    counted_total: view.total_value,
    ledger_total: sumOre(adjustments.map((a) => a.ledger)),
    adjustments,
    lines: stockAdjustmentLines(adjustments),
  }
}

function stockCountBusinessEvent(args: { fiscalPeriodId: string; balanceDate: string; amount: number }): BusinessEventDraft {
  return {
    kind: 'year_end.closing',
    category: null,
    occurredOn: args.balanceDate,
    subject: { type: 'fiscal_period', id: args.fiscalPeriodId },
    currency: 'SEK',
    amount: args.amount,
    amountSek: args.amount,
    ...postingEvidence(linkBasisColumns('user_created')),
    mappingVersion: mappingVersion('inventoryCount'),
    jurisdiction: 'SE',
  }
}

export interface BookStockCountResult {
  count: StockCountRecord
  entry: JournalEntry | null
  preview: StockCountBookingPreview
}

/** Book a signed count's lagerförändring and mark the count booked. */
export async function bookStockCount(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  id: string,
): Promise<BookStockCountResult> {
  const record = await loadStockCountRecord(supabase, companyId, id)
  if (record.status === 'booked') throw new StockCountError('STOCK_COUNT_ALREADY_BOOKED')
  if (record.status !== 'signed') throw new StockCountError('STOCK_COUNT_NOT_SIGNED')
  const { data: other, error: otherError } = await supabase
    .from('inventory_counts')
    .select('id')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', record.fiscal_period_id)
    .eq('status', 'booked')
    .limit(1)
  if (otherError) throw otherError
  if ((other ?? []).length > 0) throw new StockCountError('STOCK_COUNT_ALREADY_BOOKED', { fiscal_period_id: record.fiscal_period_id })

  const preview = await previewStockCountBooking(supabase, companyId, id, { record })
  let entry: JournalEntry | null = null
  if (preview.lines.length > 0) {
    const amount = sumOre(preview.lines.map((l) => l.debit_amount))
    entry = await postingPort.postJournalEntry({
      supabase,
      companyId,
      userId,
      event: () => stockCountBusinessEvent({ fiscalPeriodId: record.fiscal_period_id, balanceDate: record.balance_date, amount }),
      input: {
        fiscal_period_id: record.fiscal_period_id,
        entry_date: record.balance_date,
        description: `Lagerförändring enligt inventering per ${record.balance_date}`,
        source_type: 'year_end',
        voucher_series: 'A',
        lines: preview.lines,
      },
    })
  }

  const { data, error } = await supabase
    .from('inventory_counts')
    .update({ status: 'booked', journal_entry_id: entry?.id ?? null, booked_at: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('id', id)
    .eq('status', 'signed')
    .select('id, company_id, fiscal_period_id, balance_date, count_date, roll_forward_note, note, status, signer_name, signed_at, signed_document_id, signing_request_id, journal_entry_id, booked_at, created_at, updated_at')
    .maybeSingle()
  if (error) throw stockCountErrorFromDb(error) ?? error
  if (!data) throw new StockCountError('STOCK_COUNT_ALREADY_BOOKED')

  // The signed list is the verifikat's underlag (BFL 5 kap 6 §): linked, it
  // is kept with the verifikat by the retention triggers.
  if (entry && record.signed_document_id) {
    try {
      await linkToJournalEntry(supabase, companyId, record.signed_document_id, entry.id, linkBasisColumns('system_derived'))
    } catch (err) {
      log.warn('signed inventory list not linked to the verifikat', {
        countId: id,
        entryId: entry.id,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { count: data as unknown as StockCountRecord, entry, preview }
}
