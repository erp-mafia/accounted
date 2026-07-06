import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

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
 * Uses a joined query with pagination to handle any number of entries.
 * Avoids the broken .in(entryIds) pattern that silently truncated at 1000 rows.
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

  // Fetch all lines with joined entry data: single paginated query,
  // no entry ID array, no truncation at 1000 rows
  // Supabase types !inner joins as arrays; for many-to-one (line → entry)
  // it returns a single object at runtime. Cast via `as any` on the query.
  const rawLines = await fetchAllRows<{
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
  }>(({ from, to }) => {
    return supabase
      .from('journal_entry_lines')
      .select('id, account_number, debit_amount, credit_amount, journal_entry_id, journal_entries!inner(id, entry_date, voucher_number, voucher_series, description, source_type, status, company_id, fiscal_period_id)')
      .eq('journal_entries.company_id', companyId)
      .eq('journal_entries.fiscal_period_id', periodId)
      .in('journal_entries.status', ['posted', 'reversed'])
      // Stable total order on the line PK: without it, rows duplicate/skip
      // across pages and entries appear twice or go missing (see fetch-all.ts).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .order('id', { ascending: true }).range(from, to) as any
  }, { dedupeBy: (r) => r.id })

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
