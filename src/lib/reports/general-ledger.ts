import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { equalOre, roundOre } from '@/lib/money'
import { dbError } from '@/lib/errors/db-error'
import { getOpeningBalances } from './opening-balances'
import { arrangeLedgerRows, type LedgerRowSort } from './general-ledger-rows'

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
 * How generateGeneralLedger reads the period's lines. A ledger of at most
 * `singleRead` lines comes in one get_general_ledger_lines call; a larger one
 * account by account, at most `page` lines a call, through
 * get_general_ledger_account_page (the reads the huvudbok view pages with).
 * Both give the same lines in the same order.
 *
 * Why: for the largest ledgers one call for the year outlasts the 8 s
 * statement timeout every PostgREST call runs under whenever their lines are
 * not cached, so their full-year huvudbok failed. A cold read costs a disk
 * read per block. A verifikat's lines sit together, so the one call reads
 * about a block per entry and one per few lines; an account's lines each sit
 * on their own verifikat, so a page costs about two reads a line. Both limits
 * keep a fully cold call a few seconds long.
 */
export interface LedgerReadLimits {
  singleRead: number
  /** At most GENERAL_LEDGER_ARRANGE_READ_SIZE, the most a page call returns. */
  page: number
}

export const LEDGER_READ_LIMITS: LedgerReadLimits = { singleRead: 5_000, page: 2_000 }

/**
 * Generate general ledger (huvudbok) for a fiscal period.
 * BFL 5 kap. 1 §: systematisk ordning: all transactions grouped by account.
 *
 * The period's lines come in report order (account, date, voucher number,
 * line id), already narrowed to the account range, the dimension filter and
 * the window's end: in one call, or a page at a time for a large ledger
 * (LedgerReadLimits). Every line is returned, so this is for exports and
 * integrations; the huvudbok view reads generateGeneralLedgerOverview and one
 * account page at a time.
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
    /** Defaults to LEDGER_READ_LIMITS; a test lowers them to compare the two reads. */
    readLimits?: LedgerReadLimits
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
  // be missed. The window is the read's length (seconds for a ledger read in
  // pages) and the consequence is a single stale report: acceptable.
  const rawLines = await fetchLedgerLines(supabase, {
    companyId,
    periodId,
    accountFrom,
    accountTo,
    toDate: options?.toDate,
    obEntryId,
    dimensions: dimensionFilter,
  }, options?.readLimits ?? LEDGER_READ_LIMITS)

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
    if (!inAccountRange({ accountFrom, accountTo }, accNum)) continue

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

interface LedgerLinesScope {
  companyId: string
  periodId: string
  accountFrom?: string
  accountTo?: string
  fromDate?: string
  toDate?: string
  obEntryId: string | null
  dimensions?: Record<string, string>
}

/** Accounts whose pages are read side by side in a large ledger. */
const ACCOUNTS_IN_FLIGHT = 3

/**
 * Every line of the posted period in [fromDate, toDate] in report order,
 * without the OB entry: in one call when the scope holds at most
 * `limits.singleRead` lines, otherwise account by account a page at a time,
 * the accounts in the order the single call sorts them.
 *
 * The one call reads one state of the ledger. Pages are separate statements,
 * so a verifikat booked, corrected or retagged while they run could show one
 * way in some accounts' pages and another way in others'. readWasWhole says
 * whether that happened; if it did, the ledger is read again, and a second
 * time is a retryable conflict (40001).
 */
async function fetchLedgerLines(
  supabase: SupabaseClient,
  scope: LedgerLinesScope,
  limits: LedgerReadLimits,
): Promise<LedgerLineRow[]> {
  const planned = await ledgerLineCountsInScope(supabase, scope)
  const total = planned.reduce((sum, account) => sum + account.lines, 0)
  if (total <= limits.singleRead) return readLedgerLinesAtOnce(supabase, scope)

  for (let attempt = 1; ; attempt++) {
    // The marks first, then the accounts to read: an account booked after
    // the marks were read moves them, one booked before is in the list.
    const marks = await ledgerMarks(supabase, scope)
    const accounts = await ledgerLineCountsInScope(supabase, scope)
    const rows = await readLedgerLinesByAccount(supabase, scope, accounts, limits.page)
    if (await readWasWhole(supabase, scope, rows, marks)) return rows
    if (attempt === 2) {
      throw dbError({ code: '40001', message: 'the ledger changed while its pages were read' }, 'general ledger read')
    }
  }
}

/**
 * Whether the pages are one state of the ledger: no write to it landed while
 * they were read. The marks (ledgerMarks) must be as before the pages. Under
 * no filter or one dimension value the summaries answer the filter too, and
 * each account's lines read, debit and credit must equal them, which also
 * catches a page cut short.
 */
async function readWasWhole(
  supabase: SupabaseClient,
  scope: LedgerLinesScope,
  rows: LedgerLineRow[],
  marksBefore: LedgerMarks,
): Promise<boolean> {
  const summariesAnswer = !scope.dimensions || Object.keys(scope.dimensions).length === 1
  const [marks, totals] = await Promise.all([
    ledgerMarks(supabase, scope),
    summariesAnswer ? ledgerTotalsInScope(supabase, scope) : null,
  ])
  if (!sameMarks(marks, marksBefore)) return false
  return totals === null || sameTotals(totalsOfLines(rows), totals)
}

/**
 * What every write to the period's ledger moves:
 * - the period's posted and reversed verifikat, how many and when one was
 *   last written: a booking, a deletion, a storno, a status change or a
 *   rättelse of a verifikat's own fields (drafts are not the ledger);
 * - the company's rättelse and retag logs: a rättelse of lines and a
 *   dimension retag each add a row, and no row is ever removed.
 *
 * The last write is a transaction's start time, so an update that began
 * before the marks were read and lands during the pages can hide behind a
 * later one; that window is the length of one write.
 */
interface LedgerMarks {
  entries: number
  lastWritten: string | null
  rattelser: number
  retags: number
}

async function ledgerMarks(supabase: SupabaseClient, scope: LedgerLinesScope): Promise<LedgerMarks> {
  const [entries, rattelser, retags] = await Promise.all([
    // The last write, with how many there are (the count of every row the filter matches).
    supabase
      .from('journal_entries')
      .select('updated_at', { count: 'exact' })
      .eq('company_id', scope.companyId)
      .eq('fiscal_period_id', scope.periodId)
      .in('status', ['posted', 'reversed'])
      .order('updated_at', { ascending: false, nullsFirst: false })
      .limit(1),
    supabase.from('journal_entry_rattelse_log').select('id', { count: 'exact', head: true }).eq('company_id', scope.companyId),
    supabase.from('dimension_retag_log').select('id', { count: 'exact', head: true }).eq('company_id', scope.companyId),
  ])
  if (entries.error) throw dbError(entries.error, 'journal_entries marks failed')
  if (rattelser.error) throw dbError(rattelser.error, 'journal_entry_rattelse_log count failed')
  if (retags.error) throw dbError(retags.error, 'dimension_retag_log count failed')
  const latest = (Array.isArray(entries.data) ? entries.data[0] : null) as { updated_at?: string | null } | null | undefined
  return {
    entries: entries.count ?? 0,
    lastWritten: latest?.updated_at ?? null,
    rattelser: rattelser.count ?? 0,
    retags: retags.count ?? 0,
  }
}

function sameMarks(a: LedgerMarks, b: LedgerMarks): boolean {
  return a.entries === b.entries && a.lastWritten === b.lastWritten && a.rattelser === b.rattelser && a.retags === b.retags
}

/** The accounts' lines in the accounts' order, ACCOUNTS_IN_FLIGHT accounts read side by side. */
async function readLedgerLinesByAccount(
  supabase: SupabaseClient,
  scope: LedgerLinesScope,
  accounts: ReadonlyArray<{ account_number: string }>,
  pageLines: number,
): Promise<LedgerLineRow[]> {
  // One failed account fails the read: the accounts beside it stop at their next page.
  const read = { failed: false }
  const rows: LedgerLineRow[] = []
  for (let i = 0; i < accounts.length; i += ACCOUNTS_IN_FLIGHT) {
    const batch = await Promise.all(
      accounts
        .slice(i, i + ACCOUNTS_IN_FLIGHT)
        .map((account) => readAccountLines(supabase, scope, account.account_number, pageLines, read)),
    )
    for (const accountRows of batch) {
      for (const row of accountRows) rows.push(row)
    }
  }
  return rows
}

/** An account inside the huvudbok's account range (either bound open when empty). */
function inAccountRange(range: { accountFrom?: string; accountTo?: string }, accNum: string): boolean {
  return !(range.accountFrom && accNum < range.accountFrom) && !(range.accountTo && accNum > range.accountTo)
}

/**
 * The accounts with lines in the scope's window and account range, with how
 * many, in account order. Counted without the dimension filter, which the
 * summaries answer for any filter: a filtered ledger holds at most these
 * lines, so the count still bounds every read.
 */
async function ledgerLineCountsInScope(
  supabase: SupabaseClient,
  scope: LedgerLinesScope,
): Promise<Array<{ account_number: string; lines: number }>> {
  const { data, error } = await supabase.rpc('get_ledger_line_counts', {
    p_company_id: scope.companyId,
    p_fiscal_period_id: scope.periodId,
    p_from_date: scope.fromDate ?? null,
    p_to_date: scope.toDate ?? null,
    p_exclude_entry_id: scope.obEntryId,
    p_dimensions: null,
  })
  if (error) throw dbError(error, 'get_ledger_line_counts failed')
  const counts: Array<{ account_number: string; lines: number }> = []
  for (const raw of (Array.isArray(data) ? data : []) as Array<{ account_number?: unknown; line_count?: unknown }>) {
    const accNum = String(raw.account_number ?? '')
    if (inAccountRange(scope, accNum)) counts.push({ account_number: accNum, lines: Number(raw.line_count) || 0 })
  }
  return counts
}

interface AccountTotals {
  lines: number
  debit: number
  credit: number
}

/**
 * Per account in the scope's range: its lines, debit and credit in the
 * window, under the filter, from the summaries (the counts, and the trial
 * balance with the closing included).
 */
async function ledgerTotalsInScope(
  supabase: SupabaseClient,
  scope: LedgerLinesScope,
): Promise<Map<string, AccountTotals>> {
  const window = {
    p_company_id: scope.companyId,
    p_fiscal_period_id: scope.periodId,
    p_from_date: scope.fromDate ?? null,
    p_to_date: scope.toDate ?? null,
    p_exclude_entry_id: scope.obEntryId,
    p_dimensions: scope.dimensions ?? null,
  }
  const [counts, sums] = await Promise.all([
    supabase.rpc('get_ledger_line_counts', window),
    supabase.rpc('get_trial_balance_aggregates', { ...window, p_closing_mode: 'include' }),
  ])
  if (counts.error) throw dbError(counts.error, 'get_ledger_line_counts failed')
  if (sums.error) throw dbError(sums.error, 'get_trial_balance_aggregates failed')

  const totals = new Map<string, AccountTotals>()
  const totalsOf = (accNum: string) => {
    let account = totals.get(accNum)
    if (!account) totals.set(accNum, (account = { lines: 0, debit: 0, credit: 0 }))
    return account
  }
  for (const raw of (Array.isArray(counts.data) ? counts.data : []) as Array<{ account_number?: unknown; line_count?: unknown }>) {
    const accNum = String(raw.account_number ?? '')
    if (inAccountRange(scope, accNum)) totalsOf(accNum).lines += Number(raw.line_count) || 0
  }
  for (const raw of (Array.isArray(sums.data) ? sums.data : []) as Array<{
    bucket?: unknown
    account_number?: unknown
    debit?: unknown
    credit?: unknown
  }>) {
    const accNum = String(raw.account_number ?? '')
    if (raw.bucket !== 'period' || !inAccountRange(scope, accNum)) continue
    const account = totalsOf(accNum)
    account.debit += Number(raw.debit) || 0
    account.credit += Number(raw.credit) || 0
  }
  return totals
}

/** Per account: the lines read, their debit and their credit. */
function totalsOfLines(rows: LedgerLineRow[]): Map<string, AccountTotals> {
  const totals = new Map<string, AccountTotals>()
  for (const row of rows) {
    let account = totals.get(row.account_number)
    if (!account) totals.set(row.account_number, (account = { lines: 0, debit: 0, credit: 0 }))
    account.lines += 1
    account.debit += Number(row.debit_amount) || 0
    account.credit += Number(row.credit_amount) || 0
  }
  return totals
}

/** The same accounts with as many lines and the same debit and credit, to the öre. */
function sameTotals(read: Map<string, AccountTotals>, ledger: Map<string, AccountTotals>): boolean {
  if (read.size !== ledger.size) return false
  for (const [accNum, a] of read) {
    const b = ledger.get(accNum)
    if (!b || a.lines !== b.lines || !equalOre(a.debit, b.debit) || !equalOre(a.credit, b.credit)) return false
  }
  return true
}

/** One account's lines in the scope, in line order, read a page at a time to its end. */
async function readAccountLines(
  supabase: SupabaseClient,
  scope: LedgerLinesScope,
  accountNumber: string,
  pageLines: number,
  read: { failed: boolean },
): Promise<LedgerLineRow[]> {
  // A page shorter than asked for ends the account, so never ask for more
  // than the call returns.
  const limit = Math.min(Math.max(Math.floor(pageLines), 1), GENERAL_LEDGER_ARRANGE_READ_SIZE)
  const rows: LedgerLineRow[] = []
  let after: GeneralLedgerCursor | null = null
  while (!read.failed) {
    const { data, error } = await supabase.rpc('get_general_ledger_account_page', {
      p_company_id: scope.companyId,
      p_fiscal_period_id: scope.periodId,
      p_account_number: accountNumber,
      p_from_date: scope.fromDate ?? null,
      p_to_date: scope.toDate ?? null,
      p_exclude_entry_id: scope.obEntryId,
      p_dimensions: scope.dimensions ?? null,
      p_after_date: after?.date ?? null,
      p_after_voucher: after?.voucher_number ?? null,
      p_after_line_id: after?.line_id ?? null,
      p_limit: limit,
    })
    if (error) {
      read.failed = true
      throw dbError(error, 'get_general_ledger_account_page failed')
    }
    const page = (data ?? {}) as { lines?: LedgerLineRow[] }
    const lines = Array.isArray(page.lines) ? page.lines : []
    for (const line of lines) rows.push(line)
    const last = lines[lines.length - 1]
    if (lines.length < limit || !last) return rows
    const next = { date: last.entry_date, voucher_number: last.voucher_number, line_id: last.line_id }
    // Every page starts after the one before; a full page that does not move
    // the cursor would be read forever.
    if (after && !cursorAfter(next, after)) {
      read.failed = true
      throw new Error(`get_general_ledger_account_page did not move past ${after.date} ${after.voucher_number} on ${accountNumber}`)
    }
    after = next
  }
  // Another account failed: this read is discarded with it.
  return rows
}

/** Whether `a` comes after `b` in line order: date, voucher number, line id (a uuid orders as its text). */
function cursorAfter(a: GeneralLedgerCursor, b: GeneralLedgerCursor): boolean {
  if (a.date !== b.date) return a.date > b.date
  if (a.voucher_number !== b.voucher_number) return a.voucher_number > b.voucher_number
  return a.line_id > b.line_id
}

/** The scope's lines in one get_general_ledger_lines call. */
async function readLedgerLinesAtOnce(
  supabase: SupabaseClient,
  scope: LedgerLinesScope,
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
  const inRange = (accNum: string) => inAccountRange({ accountFrom, accountTo }, accNum)

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

  // At most GENERAL_LEDGER_INLINE_LINES lines, counted above: one call.
  const rows = totalLines === 0
    ? []
    : await readLedgerLinesAtOnce(supabase, {
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

/** One page of an account's lines in another order than the ledger's, or narrowed by a search. */
export interface GeneralLedgerArrangedPage {
  lines: GeneralLedgerLine[]
  /** How many lines the arrangement holds over all its pages: the account's window lines, or those the search found. */
  line_count: number
  /** Where the next page starts, or null when this one ends the arrangement. */
  next_offset: number | null
  /** With a search: the debit and credit of every line it found, on all pages. Null without one. */
  matched: { debit: number; credit: number } | null
}

/** Lines per read while an account is collected for an arrangement: the most get_general_ledger_account_page returns. */
const GENERAL_LEDGER_ARRANGE_READ_SIZE = 5000

/**
 * One account's huvudbok lines sorted on something else than ledger order,
 * or narrowed by a search, from `offset` on, at most GENERAL_LEDGER_PAGE_SIZE.
 *
 * The account's window lines are read to their end through
 * generateGeneralLedgerAccountPage, so every line is the line the ledger
 * view shows and carries the balance it shows there (the balance after that
 * line in ledger order); arrangeLedgerRows then only filters and reorders
 * them. Neither a sort on an amount nor a search on text has an index to
 * answer it: either way every line of the account is read, here in reads of
 * 5 000, so the cost follows the account, not the period.
 */
export async function generateGeneralLedgerArrangedPage(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
  accountNumber: string,
  options: LedgerScopeOptions & {
    sort?: LedgerRowSort | null
    search?: string | null
    offset?: number
    limit?: number
  },
): Promise<GeneralLedgerArrangedPage> {
  const lines: GeneralLedgerLine[] = []
  let after: GeneralLedgerCursor | undefined
  do {
    const page = await generateGeneralLedgerAccountPage(supabase, companyId, periodId, accountNumber, {
      dimensions: options.dimensions,
      fromDate: options.fromDate,
      toDate: options.toDate,
      after,
      limit: GENERAL_LEDGER_ARRANGE_READ_SIZE,
    })
    lines.push(...page.lines)
    after = page.next ?? undefined
  } while (after)

  const arranged = arrangeLedgerRows(lines, { sort: options.sort, search: options.search })
  const offset = options.offset ?? 0
  const end = offset + (options.limit ?? GENERAL_LEDGER_PAGE_SIZE)
  return {
    lines: arranged.rows.slice(offset, end),
    line_count: arranged.rows.length,
    next_offset: end < arranged.rows.length ? end : null,
    matched: arranged.matched,
  }
}
