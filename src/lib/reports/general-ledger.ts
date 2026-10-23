import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { roundOre } from '@/lib/money'
import { dbError } from '@/lib/errors/db-error'
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
 * One journal line with its verifikat's fields, as the ledger RPCs return it
 * (get_general_ledger_lines, get_general_ledger_account_page).
 */
interface LedgerLineRow {
  line_id: string
  account_number: string
  debit_amount: number | string | null
  credit_amount: number | string | null
  dimensions: Record<string, string> | null
  journal_entry_id: string
  entry_date: string
  voucher_series: string | null
  voucher_number: number
  description: string | null
  source_type: string | null
}

/**
 * Generate general ledger (huvudbok) for a fiscal period.
 * BFL 5 kap. 1 §: systematisk ordning: all transactions grouped by account.
 *
 * The period's lines come from one get_general_ledger_lines call, in report
 * order (account, date, voucher number, line id) and already narrowed to the
 * account range, the dimension filter and the window's end. Every line is
 * returned, so this is for exports and integrations; the huvudbok view reads
 * generateGeneralLedgerOverview and one account page at a time.
 *
 * Opening balances use the opening_balance_entry set by year-end closing
 * when available; falls back to summing prior-period entries. They are
 * computed for all accounts and the account range is applied to them while
 * building the result.
 */
export async function generateGeneralLedger(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
  accountFrom?: string,
  accountTo?: string,
  options?: {
    /** SIE dim → code filter ({"6":"P001"}). Opening balances are scoped
     *  to it too: the IB lines tagged with the object (issue #3313), so a
     *  project's ledger opens at the project's IB. A dimension that resets
     *  annually (registry flag) opens at zero. */
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
    supabase, companyId, period, { dimensions: dimensionFilter }
  )

  // Convert to net balance (debit - credit) for GL running balance
  const openingBalances = new Map<string, number>()
  for (const [accNum, { debit, credit }] of openingByAccount) {
    openingBalances.set(accNum, debit - credit)
  }

  // ── Period lines (excluding OB entry) ──
  // Race condition note: if year-end closing runs concurrently and creates
  // the OB entry between the period query and this query, the entry could
  // be missed. The window is sub-second and the consequence is a single
  // stale report: acceptable.
  const rawLines = await fetchLedgerLines(supabase, {
    companyId,
    periodId,
    accountFrom,
    accountTo,
    toDate: options?.toDate,
    obEntryId,
    dimensions: dimensionFilter,
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
    const accNum = line.account_number

    if (toDate && line.entry_date > toDate) continue
    if (fromDate && line.entry_date < fromDate) {
      preRangeMovements.set(accNum, (preRangeMovements.get(accNum) || 0) + lineDebit(line) - lineCredit(line))
      continue
    }

    if (!accountLines.has(accNum)) {
      accountLines.set(accNum, [])
    }

    accountLines.get(accNum)!.push(toLedgerLine(line))
  }

  // Opening balance at the range start: period IB plus movements before
  // fromDate. Under a dimension filter both are scoped to it: the IB to the
  // object's tagged IB lines, the pre-range movements by the query.
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

function lineDebit(row: LedgerLineRow): number {
  return roundOre(Number(row.debit_amount) || 0)
}

function lineCredit(row: LedgerLineRow): number {
  return roundOre(Number(row.credit_amount) || 0)
}

/** A ledger RPC row as a huvudbok line; the balance is filled in by the caller. */
function toLedgerLine(row: LedgerLineRow): GeneralLedgerLine {
  const hasDims = row.dimensions && Object.keys(row.dimensions).length > 0
  return {
    date: row.entry_date,
    voucher_series: row.voucher_series || 'A',
    voucher_number: row.voucher_number,
    journal_entry_id: row.journal_entry_id,
    description: row.description || '',
    source_type: row.source_type || '',
    debit: lineDebit(row),
    credit: lineCredit(row),
    balance: 0,
    ...(hasDims ? { dimensions: row.dimensions as Record<string, string> } : {}),
  }
}

/** Every line of the posted period in [fromDate, toDate] in report order, without the OB entry. */
async function fetchLedgerLines(
  supabase: SupabaseClient,
  scope: {
    companyId: string
    periodId: string
    accountFrom?: string
    accountTo?: string
    fromDate?: string
    toDate?: string
    obEntryId: string | null
    dimensions?: Record<string, string>
  },
): Promise<LedgerLineRow[]> {
  const { data, error } = await supabase.rpc('get_general_ledger_lines', {
    p_company_id: scope.companyId,
    p_fiscal_period_id: scope.periodId,
    p_account_from: scope.accountFrom || null,
    p_account_to: scope.accountTo || null,
    p_from_date: scope.fromDate ?? null,
    p_to_date: scope.toDate ?? null,
    p_exclude_entry_id: scope.obEntryId,
    p_dimensions: scope.dimensions ?? null,
  })
  if (error) throw dbError(error, 'get_general_ledger_lines failed')
  return (Array.isArray(data) ? data : []) as LedgerLineRow[]
}

// ── The huvudbok view: an overview, then one account's lines a page at a time ──

/** At most this many lines in the whole overview come with it, so a small ledger reads as one page. */
export const GENERAL_LEDGER_INLINE_LINES = 2000

/** Lines per account page. */
export const GENERAL_LEDGER_PAGE_SIZE = 500

/** Where an account page ends: the last line shown. */
export interface GeneralLedgerCursor {
  date: string
  voucher_number: number
  line_id: string
}

export interface GeneralLedgerOverviewAccount {
  account_number: string
  account_name: string
  opening_balance: number
  closing_balance: number
  total_debit: number
  total_credit: number
  line_count: number
  /** The account's lines, when the overview carries them (see lines_included). */
  lines?: GeneralLedgerLine[]
}

export interface GeneralLedgerOverview {
  accounts: GeneralLedgerOverviewAccount[]
  period: { start: string; end: string }
  /** True when every account's lines are in `lines`; otherwise they are read per account. */
  lines_included: boolean
}

export interface GeneralLedgerAccountPage {
  lines: GeneralLedgerLine[]
  /** The cursor for the next page, or null when this one ends the account. */
  next: GeneralLedgerCursor | null
}

interface LedgerScopeOptions {
  dimensions?: Record<string, string>
  fromDate?: string
  toDate?: string
}

async function fetchLedgerPeriod(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
): Promise<{ period_start: string; period_end: string; opening_balance_entry_id: string | null } | null> {
  const { data } = await supabase
    .from('fiscal_periods')
    .select('period_start, period_end, opening_balance_entry_id')
    .eq('id', periodId)
    .eq('company_id', companyId)
    .single()
  return data ?? null
}

function dimensionScope(options?: LedgerScopeOptions): Record<string, string> | undefined {
  return options?.dimensions && Object.keys(options.dimensions).length > 0 ? options.dimensions : undefined
}

/**
 * The huvudbok's accounts without their lines: per account the opening
 * balance at the window start, the window's debit and credit, the closing
 * balance and how many lines it has, the same accounts and numbers
 * generateGeneralLedger returns. Movements and counts come from the posted
 * ledger's summaries (get_trial_balance_aggregates, get_ledger_line_counts),
 * so the cost does not grow with the number of verifikat. When the accounts
 * in range have at most GENERAL_LEDGER_INLINE_LINES lines in all, their
 * lines come along, with running balances, and lines_included is true.
 */
export async function generateGeneralLedgerOverview(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
  accountFrom?: string,
  accountTo?: string,
  options?: LedgerScopeOptions,
): Promise<GeneralLedgerOverview> {
  const dimensionFilter = dimensionScope(options)
  const period = await fetchLedgerPeriod(supabase, companyId, periodId)
  if (!period) {
    return { accounts: [], period: { start: '', end: '' }, lines_included: true }
  }
  const window = { start: options?.fromDate ?? period.period_start, end: options?.toDate ?? period.period_end }

  const { balances: openingByAccount, obEntryId } = await getOpeningBalances(
    supabase, companyId, period, { dimensions: dimensionFilter }
  )

  const [activity, counts, names] = await Promise.all([
    supabase.rpc('get_trial_balance_aggregates', {
      p_company_id: companyId,
      p_fiscal_period_id: periodId,
      p_closing_mode: 'include',
      p_from_date: options?.fromDate ?? null,
      p_to_date: options?.toDate ?? null,
      p_exclude_entry_id: obEntryId,
      p_dimensions: dimensionFilter ?? null,
    }),
    supabase.rpc('get_ledger_line_counts', {
      p_company_id: companyId,
      p_fiscal_period_id: periodId,
      p_from_date: options?.fromDate ?? null,
      p_to_date: options?.toDate ?? null,
      p_exclude_entry_id: obEntryId,
      p_dimensions: dimensionFilter ?? null,
    }),
    fetchAllRows<{ account_number: string; account_name: string }>(({ from, to }) =>
      supabase
        .from('chart_of_accounts')
        .select('account_number, account_name')
        .eq('company_id', companyId)
        .order('account_number', { ascending: true })
        .range(from, to)
    ),
  ])
  if (activity.error) throw dbError(activity.error, 'get_trial_balance_aggregates failed')
  if (counts.error) throw dbError(counts.error, 'get_ledger_line_counts failed')

  // Opening at the window start: the IB plus the period's movement before it.
  const opening = new Map<string, number>()
  for (const [accNum, { debit, credit }] of openingByAccount) {
    opening.set(accNum, debit - credit)
  }
  const movement = new Map<string, { debit: number; credit: number }>()
  for (const raw of (Array.isArray(activity.data) ? activity.data : []) as Array<{
    bucket?: unknown
    account_number?: unknown
    debit?: unknown
    credit?: unknown
  }>) {
    const accNum = String(raw.account_number ?? '')
    const debit = Number(raw.debit) || 0
    const credit = Number(raw.credit) || 0
    if (raw.bucket === 'rollforward') {
      opening.set(accNum, (opening.get(accNum) || 0) + debit - credit)
    } else if (raw.bucket === 'period') {
      const m = movement.get(accNum) ?? { debit: 0, credit: 0 }
      movement.set(accNum, { debit: m.debit + debit, credit: m.credit + credit })
    }
  }
  const lineCount = new Map<string, number>()
  for (const raw of (Array.isArray(counts.data) ? counts.data : []) as Array<{ account_number?: unknown; line_count?: unknown }>) {
    lineCount.set(String(raw.account_number ?? ''), Number(raw.line_count) || 0)
  }
  const nameByAccount = new Map(names.map((a) => [a.account_number, a.account_name]))

  // The accounts with lines in the window, and those carrying a balance into it.
  const accountNumbers = new Set<string>(lineCount.keys())
  for (const [accNum, balance] of opening) {
    if (Math.abs(balance) > 0.005) accountNumbers.add(accNum)
  }
  const inRange = (accNum: string) => !(accountFrom && accNum < accountFrom) && !(accountTo && accNum > accountTo)

  const accounts: GeneralLedgerOverviewAccount[] = Array.from(accountNumbers)
    .filter(inRange)
    .sort((a, b) => a.localeCompare(b))
    .map((accNum) => {
      const openingBalance = roundOre(opening.get(accNum) || 0)
      const m = movement.get(accNum) ?? { debit: 0, credit: 0 }
      return {
        account_number: accNum,
        account_name: nameByAccount.get(accNum) || `Konto ${accNum}`,
        opening_balance: openingBalance,
        closing_balance: roundOre(openingBalance + m.debit - m.credit),
        total_debit: roundOre(m.debit),
        total_credit: roundOre(m.credit),
        line_count: lineCount.get(accNum) || 0,
      }
    })

  const totalLines = accounts.reduce((sum, a) => sum + a.line_count, 0)
  if (totalLines > GENERAL_LEDGER_INLINE_LINES) {
    return { accounts, period: window, lines_included: false }
  }

  const rows = totalLines === 0
    ? []
    : await fetchLedgerLines(supabase, {
        companyId,
        periodId,
        accountFrom,
        accountTo,
        fromDate: options?.fromDate,
        toDate: options?.toDate,
        obEntryId,
        dimensions: dimensionFilter,
      })
  const linesByAccount = new Map<string, LedgerLineRow[]>()
  for (const row of rows) {
    const list = linesByAccount.get(row.account_number)
    if (list) list.push(row)
    else linesByAccount.set(row.account_number, [row])
  }
  for (const account of accounts) {
    account.lines = withBalances(account.opening_balance, linesByAccount.get(account.account_number) ?? [])
  }
  return { accounts, period: window, lines_included: true }
}

/** Lines in order with the running balance from `start`. */
function withBalances(start: number, rows: LedgerLineRow[]): GeneralLedgerLine[] {
  let running = start
  return rows.map((row) => {
    const line = toLedgerLine(row)
    running += line.debit - line.credit
    line.balance = roundOre(running)
    return line
  })
}

/**
 * One account's huvudbok lines from `after` on (the start of the window when
 * omitted), at most GENERAL_LEDGER_PAGE_SIZE, with running balances that
 * continue the account's balance from its opening: the same lines and
 * balances generateGeneralLedger shows for the account, a page at a time.
 */
export async function generateGeneralLedgerAccountPage(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
  accountNumber: string,
  options?: LedgerScopeOptions & { after?: GeneralLedgerCursor; limit?: number },
): Promise<GeneralLedgerAccountPage> {
  const dimensionFilter = dimensionScope(options)
  const period = await fetchLedgerPeriod(supabase, companyId, periodId)
  if (!period) return { lines: [], next: null }

  const { balances: openingByAccount, obEntryId } = await getOpeningBalances(
    supabase, companyId, period, { dimensions: dimensionFilter }
  )
  const limit = options?.limit ?? GENERAL_LEDGER_PAGE_SIZE
  const { data, error } = await supabase.rpc('get_general_ledger_account_page', {
    p_company_id: companyId,
    p_fiscal_period_id: periodId,
    p_account_number: accountNumber,
    p_from_date: options?.fromDate ?? null,
    p_to_date: options?.toDate ?? null,
    p_exclude_entry_id: obEntryId,
    p_dimensions: dimensionFilter ?? null,
    p_after_date: options?.after?.date ?? null,
    p_after_voucher: options?.after?.voucher_number ?? null,
    p_after_line_id: options?.after?.line_id ?? null,
    p_limit: limit,
  })
  if (error) throw dbError(error, 'get_general_ledger_account_page failed')

  const page = (data ?? {}) as { before_debit?: unknown; before_credit?: unknown; lines?: LedgerLineRow[] }
  const ib = openingByAccount.get(accountNumber)
  // The account's balance before the page's first line: IB plus every
  // earlier line of the period (before the window and before the cursor).
  const start = roundOre(
    (ib ? ib.debit - ib.credit : 0) + (Number(page.before_debit) || 0) - (Number(page.before_credit) || 0)
  )
  const rows = Array.isArray(page.lines) ? page.lines : []
  const last = rows[rows.length - 1]
  return {
    lines: withBalances(start, rows),
    next: rows.length >= limit && last
      ? { date: last.entry_date, voucher_number: last.voucher_number, line_id: last.line_id }
      : null,
  }
}
