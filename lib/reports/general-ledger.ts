import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { roundOre } from '@/lib/money'
import { fetchEntryLines, type EntryLinesQuery } from '@/lib/bookkeeping/entry-lines'
import { getOpeningBalances } from './opening-balances'

export interface GeneralLedgerLine {
  date: string
  voucher_series: string
  voucher_number: number
  journal_entry_id: string
  description: string
  source_type: string
  debit: number
  credit: number
  balance: number
  /** SIE dim → code tags on the line; omitted when untagged. */
  dimensions?: Record<string, string>
}

export interface GeneralLedgerAccount {
  account_number: string
  account_name: string
  opening_balance: number
  lines: GeneralLedgerLine[]
  closing_balance: number
  total_debit: number
  total_credit: number
}

export interface GeneralLedgerReport {
  accounts: GeneralLedgerAccount[]
  period: { start: string; end: string }
}

/**
 * Generate general ledger (huvudbok) for a fiscal period.
 * BFL 5 kap. 1 §: systematisk ordning: all transactions grouped by account.
 *
 * Uses the shared two-step entry-lines fetch (lib/bookkeeping/entry-lines.ts):
 * entries first, then lines chunked by entry id, both paginated, so any
 * number of entries is handled without the pathological journal_entries!inner
 * embed plan.
 *
 * Opening balances use the opening_balance_entry set by year-end closing
 * when available; falls back to summing prior-period entries.
 *
 * The account range filter (accountFrom/accountTo) is applied post-hoc
 * during result building, not in the queries. Opening balances are computed
 * for all accounts: the wasted Map entries for filtered-out accounts are
 * trivially cheap compared to the cost of the queries themselves.
 */
export async function generateGeneralLedger(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
  accountFrom?: string,
  accountTo?: string,
  options?: {
    /** SIE dim → code filter ({"6":"P001"}). Opening balances are dropped
     *  when set: they are company-wide and cannot be dimension-scoped. */
    dimensions?: Record<string, string>
    /** Inclusive date sub-range within the fiscal period (kontoanalys).
     *  Lines before fromDate roll into each account's opening balance so
     *  the running balance at the range start matches the full-year ledger;
     *  lines after toDate are dropped. Callers validate the bounds
     *  (parseReportDateRange). */
    fromDate?: string
    toDate?: string
  }
): Promise<GeneralLedgerReport> {
  const dimensionFilter =
    options?.dimensions && Object.keys(options.dimensions).length > 0
      ? options.dimensions
      : undefined

  // Get fiscal period dates and opening_balance_entry_id
  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('period_start, period_end, opening_balance_entry_id')
    .eq('id', periodId)
    .eq('company_id', companyId)
    .single()

  if (!period) {
    return { accounts: [], period: { start: '', end: '' } }
  }

  // ── Opening balances (IB) ──────────────────────────────────────
  const { balances: openingByAccount, obEntryId } = await getOpeningBalances(
    supabase, companyId, period
  )

  // Convert to net balance (debit - credit) for GL running balance
  const openingBalances = new Map<string, number>()
  if (!dimensionFilter) {
    for (const [accNum, { debit, credit }] of openingByAccount) {
      openingBalances.set(accNum, debit - credit)
    }
  }

  // ── Period lines via the two-step entry-lines fetch (excluding OB entry) ──
  // Race condition note: if year-end closing runs concurrently and creates
  // the OB entry between the period query and this query, the entry could
  // be missed. The window is sub-second and the consequence is a single
  // stale report: acceptable.
  const rawLines = await fetchEntryLines<{
    id: string
    account_number: string
    debit_amount: number
    credit_amount: number
    journal_entry_id: string
    dimensions: Record<string, string> | null
    journal_entries: {
      entry_date: string
      voucher_number: number
      voucher_series: string
      description: string
      source_type: string
    }
  }>({
    supabase,
    entryColumns:
      'entry_date, voucher_number, voucher_series, description, source_type, company_id, fiscal_period_id, status',
    lineColumns:
      'id, account_number, debit_amount, credit_amount, journal_entry_id, dimensions',
    filterEntries: (q: EntryLinesQuery) => {
      let query = q
        .eq('company_id', companyId)
        .eq('fiscal_period_id', periodId)
        .in('status', ['posted', 'reversed'])

      if (obEntryId) {
        query = query.neq('id', obEntryId)
      }

      return query
    },
    filterLines: dimensionFilter
      ? // jsonb containment (@>): served by idx_jel_dimensions_gin.
        (q: EntryLinesQuery) => q.contains('dimensions', dimensionFilter)
      : undefined,
  })

  if (rawLines.length === 0 && openingBalances.size === 0) {
    return {
      accounts: [],
      period: {
        start: options?.fromDate ?? period.period_start,
        end: options?.toDate ?? period.period_end,
      },
    }
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

  // Group lines by account. Lines before fromDate accumulate per account so
  // they can roll into the opening balance below; lines after toDate drop.
  const fromDate = options?.fromDate
  const toDate = options?.toDate
  const accountLines = new Map<string, GeneralLedgerLine[]>()
  const preRangeMovements = new Map<string, number>()

  for (const line of rawLines) {
    const entry = line.journal_entries
    const accNum = line.account_number
    const debit = Math.round((Number(line.debit_amount) || 0) * 100) / 100
    const credit = Math.round((Number(line.credit_amount) || 0) * 100) / 100

    if (toDate && entry.entry_date > toDate) continue
    if (fromDate && entry.entry_date < fromDate) {
      preRangeMovements.set(accNum, (preRangeMovements.get(accNum) || 0) + debit - credit)
      continue
    }

    if (!accountLines.has(accNum)) {
      accountLines.set(accNum, [])
    }

    const hasDims = line.dimensions && Object.keys(line.dimensions).length > 0

    accountLines.get(accNum)!.push({
      date: entry.entry_date,
      voucher_series: entry.voucher_series || 'A',
      voucher_number: entry.voucher_number,
      journal_entry_id: line.journal_entry_id,
      description: entry.description || '',
      source_type: entry.source_type || '',
      debit,
      credit,
      balance: 0, // computed below
      ...(hasDims ? { dimensions: line.dimensions as Record<string, string> } : {}),
    })
  }

  // Opening balance at the range start: period IB plus movements before
  // fromDate. Under a dimension filter the IB map is empty (company-wide IB
  // cannot be dimension-scoped) but pre-range movements are dimension-scoped
  // by the query, so they still roll in.
  const effectiveOpening = new Map<string, number>(openingBalances)
  for (const [accNum, movement] of preRangeMovements) {
    effectiveOpening.set(accNum, roundOre((effectiveOpening.get(accNum) || 0) + movement))
  }

  // Include accounts that carry a balance into the range but have no lines in it
  for (const [accNum, balance] of effectiveOpening) {
    if (!accountLines.has(accNum) && Math.abs(balance) > 0.005) {
      accountLines.set(accNum, [])
    }
  }

  // Build account summaries
  const result: GeneralLedgerAccount[] = []

  for (const [accNum, accLines] of accountLines) {
    // Apply optional account range filter
    if (accountFrom && accNum < accountFrom) continue
    if (accountTo && accNum > accountTo) continue

    // Sort by date, then voucher number
    accLines.sort((a, b) => {
      const dateCompare = a.date.localeCompare(b.date)
      if (dateCompare !== 0) return dateCompare
      return a.voucher_number - b.voucher_number
    })

    const opening = Math.round((effectiveOpening.get(accNum) || 0) * 100) / 100
    let runningBalance = opening

    for (const line of accLines) {
      runningBalance += line.debit - line.credit
      line.balance = Math.round(runningBalance * 100) / 100
    }

    const totalDebit = accLines.reduce((sum, l) => sum + l.debit, 0)
    const totalCredit = accLines.reduce((sum, l) => sum + l.credit, 0)

    result.push({
      account_number: accNum,
      account_name: accountNameMap.get(accNum) || `Konto ${accNum}`,
      opening_balance: opening,
      lines: accLines,
      closing_balance: Math.round((opening + totalDebit - totalCredit) * 100) / 100,
      total_debit: Math.round(totalDebit * 100) / 100,
      total_credit: Math.round(totalCredit * 100) / 100,
    })
  }

  // Sort by account number
  result.sort((a, b) => a.account_number.localeCompare(b.account_number))

  return {
    accounts: result,
    period: {
      start: fromDate ?? period.period_start,
      end: toDate ?? period.period_end,
    },
  }
}
