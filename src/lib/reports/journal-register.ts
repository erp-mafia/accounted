import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { dbError } from '@/lib/errors/db-error'
import { roundOre } from '@/lib/money'

export interface JournalRegisterLine {
  account_number: string
  account_name: string
  debit: number
  credit: number
}

export interface JournalRegisterEntry {
  voucher_series: string
  voucher_number: number
  date: string
  description: string
  source_type: string
  status: string
  lines: JournalRegisterLine[]
  total_debit: number
  total_credit: number
}

export interface JournalRegisterReport {
  entries: JournalRegisterEntry[]
  total_entries: number
  total_debit: number
  total_credit: number
  period: { start: string; end: string }
}

/**
 * Generate journal register (grundbok) for a fiscal period.
 * BFL 5 kap. 1 §: registreringsordning: all vouchers in chronological registration order.
 *
 * Uses the shared two-step entry-lines fetch (lib/bookkeeping/entry-lines.ts):
 * entries first, then lines chunked by entry id, both paginated, so any
 * number of entries is handled without the pathological journal_entries!inner
 * embed plan.
 *
 * Unlike the general ledger and trial balance, the grundbok includes ALL
 * entries: the opening_balance_entry is NOT excluded, because it is a
 * real voucher that should appear in registration order.
 */
export async function generateJournalRegister(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string
): Promise<JournalRegisterReport> {

  // Get fiscal period dates
  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('period_start, period_end')
    .eq('id', periodId)
    .eq('company_id', companyId)
    .single()

  if (!period) {
    return { entries: [], total_entries: 0, total_debit: 0, total_credit: 0, period: { start: '', end: '' } }
  }

  // Fetch entries and their lines via the two-step entry-lines fetch: both
  // sides paginated, lines chunked by entry id, no truncation at 1000 rows.
  const rawLines = await fetchEntryLines<{
    id: string
    account_number: string
    debit_amount: number
    credit_amount: number
    journal_entry_id: string
    journal_entries: {
      id: string
      entry_date: string
      voucher_number: number
      voucher_series: string
      description: string
      source_type: string
      status: string
    }
  }>({
    supabase,
    entryColumns:
      'id, entry_date, voucher_number, voucher_series, description, source_type, status, company_id, fiscal_period_id',
    lineColumns: 'id, account_number, debit_amount, credit_amount, journal_entry_id',
    filterEntries: (q: EntryLinesQuery) =>
      q
        .eq('company_id', companyId)
        .eq('fiscal_period_id', periodId)
        .in('status', ['posted', 'reversed']),
  })

  if (rawLines.length === 0) {
    return { entries: [], total_entries: 0, total_debit: 0, total_credit: 0, period: { start: period.period_start, end: period.period_end } }
  }

  // Fetch account names
  const accounts = await fetchAllRows<{ account_number: string; account_name: string }>(({ from, to }) =>
    supabase
      .from('chart_of_accounts')
      .select('account_number, account_name')
      .eq('company_id', companyId)
      .order('account_number', { ascending: true })
      .range(from, to)
  )

  const accountNameMap = new Map<string, string>()
  for (const acc of accounts) {
    accountNameMap.set(acc.account_number, acc.account_name)
  }

  // Extract unique entries and group lines by entry
  const entryMap = new Map<string, typeof rawLines[0]['journal_entries']>()
  const linesByEntry = new Map<string, JournalRegisterLine[]>()

  for (const line of rawLines) {
    const entryId = line.journal_entry_id
    const entry = line.journal_entries

    if (!entryMap.has(entryId)) {
      entryMap.set(entryId, entry)
    }

    if (!linesByEntry.has(entryId)) {
      linesByEntry.set(entryId, [])
    }

    linesByEntry.get(entryId)!.push({
      account_number: line.account_number,
      account_name: accountNameMap.get(line.account_number) || `Konto ${line.account_number}`,
      debit: Math.round((Number(line.debit_amount) || 0) * 100) / 100,
      credit: Math.round((Number(line.credit_amount) || 0) * 100) / 100,
    })
  }

  // Build entries sorted by voucher_series, then voucher_number (registration order)
  const sortedEntries = Array.from(entryMap.entries())
    .sort(([, a], [, b]) => {
      const seriesCompare = (a.voucher_series || 'A').localeCompare(b.voucher_series || 'A')
      if (seriesCompare !== 0) return seriesCompare
      return a.voucher_number - b.voucher_number
    })

  const result: JournalRegisterEntry[] = sortedEntries.map(([entryId, entry]) => {
    const entryLines = linesByEntry.get(entryId) || []
    // Sort lines by account number within each entry
    entryLines.sort((a, b) => a.account_number.localeCompare(b.account_number))

    const totalDebit = entryLines.reduce((sum, l) => sum + l.debit, 0)
    const totalCredit = entryLines.reduce((sum, l) => sum + l.credit, 0)

    return {
      voucher_series: entry.voucher_series || 'A',
      voucher_number: entry.voucher_number,
      date: entry.entry_date,
      description: entry.description || '',
      source_type: entry.source_type || '',
      status: entry.status,
      lines: entryLines,
      total_debit: Math.round(totalDebit * 100) / 100,
      total_credit: Math.round(totalCredit * 100) / 100,
    }
  })

  const grandTotalDebit = result.reduce((sum, e) => sum + e.total_debit, 0)
  const grandTotalCredit = result.reduce((sum, e) => sum + e.total_credit, 0)

  return {
    entries: result,
    total_entries: result.length,
    total_debit: Math.round(grandTotalDebit * 100) / 100,
    total_credit: Math.round(grandTotalCredit * 100) / 100,
    period: { start: period.period_start, end: period.period_end },
  }
}

// ── The grundbok view: the verifikat a page at a time ──

/** Verifikat per grundbok page. */
export const JOURNAL_REGISTER_PAGE_SIZE = 200

/** Where a grundbok page ends: its last verifikat. */
export interface JournalRegisterCursor {
  voucher_series: string
  voucher_number: number
  id: string
}

export interface JournalRegisterPage {
  entries: JournalRegisterEntry[]
  /** The cursor for the next page, or null when this one ends the period. */
  next: JournalRegisterCursor | null
  /** The whole period's totals, on the first page (no cursor). */
  totals?: Pick<JournalRegisterReport, 'total_entries' | 'total_debit' | 'total_credit' | 'period'>
}

interface RegisterPageRow {
  id: string
  voucher_series: string
  voucher_number: number
  entry_date: string
  description: string | null
  source_type: string | null
  status: string
  lines: Array<{ account_number: string; debit_amount: number | string | null; credit_amount: number | string | null }>
}

/**
 * One page of the grundbok: the period's posted and reversed verifikat in
 * registration order (series, then number) from `after` on, each with its
 * lines by account, the same entries generateJournalRegister lists. The
 * first page also carries the period's totals, so the view can show the
 * whole period's count and sums before every page is read.
 */
export async function generateJournalRegisterPage(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
  options?: { after?: JournalRegisterCursor; limit?: number },
): Promise<JournalRegisterPage> {
  const limit = options?.limit ?? JOURNAL_REGISTER_PAGE_SIZE
  const first = !options?.after

  const [page, accounts, period, totals] = await Promise.all([
    supabase.rpc('get_journal_register_page', {
      p_company_id: companyId,
      p_fiscal_period_id: periodId,
      p_after_series: options?.after?.voucher_series ?? null,
      p_after_number: options?.after?.voucher_number ?? null,
      p_after_id: options?.after?.id ?? null,
      // One more than the page, to know whether another follows.
      p_limit: limit + 1,
    }),
    fetchAllRows<{ account_number: string; account_name: string }>(({ from, to }) =>
      supabase
        .from('chart_of_accounts')
        .select('account_number, account_name')
        .eq('company_id', companyId)
        .order('account_number', { ascending: true })
        .range(from, to)
    ),
    first
      ? supabase.from('fiscal_periods').select('period_start, period_end').eq('id', periodId).eq('company_id', companyId).single()
      : Promise.resolve(null),
    first
      ? supabase.rpc('get_journal_register_totals', { p_company_id: companyId, p_fiscal_period_id: periodId })
      : Promise.resolve(null),
  ])
  if (page.error) throw dbError(page.error, 'get_journal_register_page failed')
  if (totals?.error) throw dbError(totals.error, 'get_journal_register_totals failed')

  const accountNameMap = new Map(accounts.map((a) => [a.account_number, a.account_name]))
  const rows = (Array.isArray(page.data) ? page.data : []) as RegisterPageRow[]
  const shown = rows.slice(0, limit)

  const entries: JournalRegisterEntry[] = shown.map((row) => {
    const lines: JournalRegisterLine[] = (row.lines ?? []).map((line) => ({
      account_number: line.account_number,
      account_name: accountNameMap.get(line.account_number) || `Konto ${line.account_number}`,
      debit: roundOre(Number(line.debit_amount) || 0),
      credit: roundOre(Number(line.credit_amount) || 0),
    }))
    return {
      voucher_series: row.voucher_series || 'A',
      voucher_number: row.voucher_number,
      date: row.entry_date,
      description: row.description || '',
      source_type: row.source_type || '',
      status: row.status,
      lines,
      total_debit: roundOre(lines.reduce((sum, l) => sum + l.debit, 0)),
      total_credit: roundOre(lines.reduce((sum, l) => sum + l.credit, 0)),
    }
  })

  const last = shown[shown.length - 1]
  const result: JournalRegisterPage = {
    entries,
    next: rows.length > limit && last
      ? { voucher_series: last.voucher_series || 'A', voucher_number: last.voucher_number, id: last.id }
      : null,
  }
  if (first) {
    const t = (totals?.data ?? {}) as { total_entries?: unknown; total_debit?: unknown; total_credit?: unknown }
    const p = period?.data as { period_start: string; period_end: string } | null | undefined
    result.totals = {
      total_entries: Number(t.total_entries) || 0,
      total_debit: roundOre(Number(t.total_debit) || 0),
      total_credit: roundOre(Number(t.total_credit) || 0),
      period: { start: p?.period_start ?? '', end: p?.period_end ?? '' },
    }
  }
  return result
}
