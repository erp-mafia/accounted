import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { formatCurrency } from '@/lib/utils'
import { ORE_TOLERANCE, roundOre } from '@/lib/money'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { getOpeningBalances } from '@/lib/reports/opening-balances'
import { findFiscalYearGaps, type PeriodLike } from '@/lib/bookkeeping/fiscal-year-gaps'
import { mappingsToMap } from './account-mapper'
import { getEffectiveOpeningBalances, isBalanceSheetAccount } from './sie-parser'
import { makeNotice, type ImportNotice } from './notices'
import type {
  AccountMapping,
  OpeningBalanceContinuity,
  OpeningBalanceDifference,
  ParsedSIEFile,
  SourceOpeningBalanceEdit,
} from './types'

const log = createLogger('sie-continuity')

/**
 * IB/UB continuity between a SIE file and the books (crm#1099).
 *
 * A year imported on top of earlier bookkeeping does not book the file's
 * #IB: it opens on the balance the books carry forward (balanskontinuitet,
 * ÅRL 2:4 p.7), which is correct. When the source system edited an opening
 * balance by hand, a year is missing, or an earlier export differs, the two
 * disagree, and the user must see by how much before importing, not find out
 * from a balance that differs from the old system. The SIE skill's rule for
 * an IB/UB mismatch: a warning with exact amounts, never a silent proceed and
 * never an automatic adjustment in the opening period.
 */

const sek = (amount: number) => formatCurrency(amount, 'SEK', { minimumFractionDigits: 2 })

/**
 * Whether an import of the year will skip the file's #IB: the test
 * start_sie_import_job seals into the job manifest as prior_activity
 * (supabase/migrations/20260911141611_sie_job_trust_boundaries.sql:95-99).
 * Any posted entry that is not an IB or a storno, dated on or before the
 * year's last day: earlier years, and also the year's own entries (a bank
 * already synced into it). `replacesImportId` mirrors p_supersedes_import_id:
 * a replacement does not count the import it replaces.
 */
async function willCarryForward(
  supabase: SupabaseClient,
  companyId: string,
  periodEnd: string,
  replacesImportId: string | null,
): Promise<boolean> {
  let query = supabase
    .from('journal_entries')
    .select('id')
    .eq('company_id', companyId)
    .eq('status', 'posted')
    .not('source_type', 'in', '(opening_balance,storno)')
    .lte('entry_date', periodEnd)
  if (replacesImportId) query = query.or(`import_batch_id.is.null,import_batch_id.neq.${replacesImportId}`)
  const { data, error } = await query.limit(1)
  if (error) throw new Error(error.message)
  return (data?.length ?? 0) > 0
}

/** The file's IB rows as a job manifest stores them (effectiveOpeningBalances), malformed rows dropped. */
export function storedOpeningBalances(stored: unknown): Array<{ account: string; amount: number; yearIndex?: number }> {
  const rows = (Array.isArray(stored) ? stored : []) as Array<{ account?: unknown; amount?: unknown; yearIndex?: unknown }>
  return rows.flatMap((row) => {
    const amount = Number(row.amount)
    if (typeof row.account !== 'string' || !Number.isFinite(amount)) return []
    return [{ account: row.account, amount, yearIndex: typeof row.yearIndex === 'number' ? row.yearIndex : undefined }]
  })
}

/**
 * The file's #IB per company account: source rows mapped through the
 * import's mappings, several source accounts on one target summed, an
 * unmapped account skipped.
 */
export function fileOpeningBalanceByAccount(
  balances: readonly { account: string; amount: number; yearIndex?: number }[],
  mappings: AccountMapping[],
): Map<string, number> {
  const accountMap = mappingsToMap(mappings)
  const byAccount = new Map<string, number>()
  for (const balance of balances) {
    if (balance.yearIndex !== undefined && balance.yearIndex !== 0) continue
    const target = accountMap.get(balance.account)
    if (!target || !Number.isFinite(balance.amount)) continue
    byAccount.set(target, roundOre((byAccount.get(target) ?? 0) + balance.amount))
  }
  return byAccount
}

/** Balance-sheet accounts where the carried-forward balance and the file's #IB differ, sorted by account. */
export function compareOpeningBalances(
  file: ReadonlyMap<string, number>,
  books: ReadonlyMap<string, { debit: number; credit: number }>,
): OpeningBalanceDifference[] {
  const rows: OpeningBalanceDifference[] = []
  for (const account of new Set([...file.keys(), ...books.keys()])) {
    if (!isBalanceSheetAccount(account)) continue
    const fileAmount = roundOre(file.get(account) ?? 0)
    const carried = books.get(account)
    const booksAmount = roundOre(carried ? carried.debit - carried.credit : 0)
    const difference = roundOre(booksAmount - fileAmount)
    if (Math.abs(difference) < ORE_TOLERANCE) continue
    rows.push({ account, file: fileAmount, books: booksAmount, difference })
  }
  return rows.sort((a, b) => a.account.localeCompare(b.account))
}

function sumByAccount(rows: readonly { account: string; amount: number }[]): Map<string, number> {
  const sums = new Map<string, number>()
  for (const row of rows) sums.set(row.account, roundOre((sums.get(row.account) ?? 0) + row.amount))
  return sums
}

/**
 * The file against itself: #IB 0 and #UB -1 per balance-sheet account. A
 * missing record is a zero balance (SIE spec 5.17). Empty when the file
 * lacks either side: a first year has no #UB -1, and an IB derived from
 * #UB -1 matches it by construction.
 */
export function findSourceOpeningBalanceEdits(
  parsed: Pick<ParsedSIEFile, 'openingBalances' | 'closingBalances'>,
): SourceOpeningBalanceEdit[] {
  const opening = sumByAccount(parsed.openingBalances.filter((b) => b.yearIndex === 0))
  const previousClosing = sumByAccount(parsed.closingBalances.filter((b) => b.yearIndex === -1))
  if (opening.size === 0 || previousClosing.size === 0) return []
  const edits: SourceOpeningBalanceEdit[] = []
  for (const account of new Set([...opening.keys(), ...previousClosing.keys()])) {
    if (!isBalanceSheetAccount(account)) continue
    const ib = opening.get(account) ?? 0
    const ub = previousClosing.get(account) ?? 0
    const difference = roundOre(ib - ub)
    if (Math.abs(difference) < ORE_TOLERANCE) continue
    edits.push({ account, previousClosing: ub, opening: ib, difference })
  }
  return edits.sort((a, b) => a.account.localeCompare(b.account))
}

/** The carried-forward balance at the year's first day against the file's #IB. */
async function compareWithBooks(
  supabase: SupabaseClient,
  companyId: string,
  fiscalYearStart: string,
  fileBalances: readonly { account: string; amount: number; yearIndex?: number }[],
  mappings: AccountMapping[],
): Promise<OpeningBalanceDifference[]> {
  // A file that states no opening balance has nothing to compare.
  if (fileBalances.length === 0) return []
  const { balances } = await getOpeningBalances(supabase, companyId, {
    period_start: fiscalYearStart,
    opening_balance_entry_id: null,
  })
  return compareOpeningBalances(fileOpeningBalanceByAccount(fileBalances, mappings), balances)
}

const FILE_PERIOD_ID = 'sie-file'

/** The holes next to the file's year, once it sits among the company's years. */
async function findMissingYears(
  supabase: SupabaseClient,
  companyId: string,
  start: string,
  end: string,
): Promise<Array<{ from: string; to: string }>> {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end')
    .eq('company_id', companyId)
  if (error) throw new Error(error.message)
  const file: PeriodLike = { id: FILE_PERIOD_ID, name: '', period_start: start, period_end: end }
  return findFiscalYearGaps([...((data ?? []) as PeriodLike[]), file])
    .filter((gap) => gap.before.id === FILE_PERIOD_ID || gap.after.id === FILE_PERIOD_ID)
    .map((gap) => ({ from: gap.missing_from, to: gap.missing_to }))
}

/**
 * Before import: what the file's year will open on against what the file
 * states. Read-only, and never fails the preview: a failed read returns null.
 */
export async function diagnoseOpeningBalanceContinuity(
  supabase: SupabaseClient,
  companyId: string,
  parsed: ParsedSIEFile,
  mappings: AccountMapping[],
  options: { replacesImportId?: string | null } = {},
): Promise<OpeningBalanceContinuity | null> {
  const start = parsed.stats.fiscalYearStart
  const end = parsed.stats.fiscalYearEnd
  if (!start || !end) return null
  try {
    const carriedForward = await willCarryForward(supabase, companyId, end, options.replacesImportId ?? null)
    const differences = carriedForward
      ? await compareWithBooks(supabase, companyId, start, getEffectiveOpeningBalances(parsed).balances, mappings)
      : []
    return {
      carriedForward,
      differences,
      sourceEdits: findSourceOpeningBalanceEdits(parsed),
      missingYears: await findMissingYears(supabase, companyId, start, end),
      noVouchers: parsed.stats.totalVouchers === 0 && end < todayIsoStockholm(),
    }
  } catch (err) {
    log.warn('opening-balance continuity check failed; the preview is unaffected', {
      companyId,
      message: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * After a continuation import (the job's sealed prior_activity): the
 * accounts where the books now open on another amount than the file stated,
 * read from the file's IB in the job manifest. Never throws: a failed read
 * costs the notice, not the import.
 */
export async function diagnoseCarriedForwardDifferences(
  supabase: SupabaseClient,
  companyId: string,
  fiscalYearStart: string,
  fileBalances: unknown,
  mappings: AccountMapping[],
): Promise<OpeningBalanceDifference[]> {
  try {
    return await compareWithBooks(supabase, companyId, fiscalYearStart, storedOpeningBalances(fileBalances), mappings)
  } catch (err) {
    log.warn('opening-balance continuity check failed; the import is unaffected', {
      companyId,
      message: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

/** Sum of the absolute differences: one figure for a notice line. */
export function totalDifference(rows: readonly { difference: number }[]): number {
  return roundOre(rows.reduce((sum, row) => sum + Math.abs(row.difference), 0))
}

/**
 * The structured notice and its Swedish legacy twin for a result whose
 * opening balance differs from the file, and for an ended year without
 * vouchers.
 */
export function continuityNotices(input: {
  differences: readonly OpeningBalanceDifference[]
  noVouchers: { from: string; to: string } | null
}): { warnings: string[]; notices: ImportNotice[] } {
  const warnings: string[] = []
  const notices: ImportNotice[] = []
  if (input.differences.length > 0) {
    const count = input.differences.length
    const amount = sek(totalDifference(input.differences))
    warnings.push(
      `Ingående balans följer föregående års utgående balans och skiljer sig från filens ingående balans på ${count} ` +
        `${count === 1 ? 'konto' : 'konton'} (sammanlagt ${amount}). Stäm av mot källsystemet.`,
    )
    notices.push(makeNotice('sie_ib_differs_from_file', 'action', { count, amount }))
  }
  if (input.noVouchers) {
    warnings.push(
      `Filen innehöll inga verifikationer för ${input.noVouchers.from} till ${input.noVouchers.to}. ` +
        'Hade företaget bokföring det året saknas den, och senare års ingående balanser blir fel.',
    )
    notices.push(makeNotice('sie_no_vouchers_past_year', 'action', input.noVouchers))
  }
  return { warnings, notices }
}

const accountList = (rows: readonly { account: string; difference: number }[]) => {
  const shown = rows.slice(0, 5).map((row) => `${row.account} (${sek(row.difference)})`).join(', ')
  return rows.length > 5 ? `${shown} och ${rows.length - 5} till` : shown
}

/** Swedish one-liners before import, for a preflight that lists warnings as text (MCP). */
export function continuityWarnings(
  continuity: OpeningBalanceContinuity,
  fiscalYear: { start: string; end: string },
): string[] {
  const lines: string[] = []
  for (const gap of continuity.missingYears) {
    lines.push(`Räkenskapsår saknas mellan företagets bokföring och filen: ${gap.from} till ${gap.to}.`)
  }
  if (continuity.differences.length > 0) {
    lines.push(
      'Filens ingående balans bokförs inte: företaget har redan bokföring fram till räkenskapsårets slut, så året ' +
        `öppnar på föregående års utgående balans. Den skiljer sig från filen på ${accountList(continuity.differences)}. ` +
        'Stäm av mot källsystemet innan importen.',
    )
  }
  if (continuity.noVouchers) {
    lines.push(
      `Filen innehåller inga verifikationer för ${fiscalYear.start} till ${fiscalYear.end}. ` +
        'Hade företaget bokföring det året saknas den, och senare års ingående balanser blir fel.',
    )
  }
  if (!continuity.carriedForward && continuity.sourceEdits.length > 0) {
    lines.push(
      `Filens ingående balans skiljer sig från föregående års utgående balans i samma fil på ${accountList(continuity.sourceEdits)}: ` +
        'den har troligen ändrats för hand i källsystemet.',
    )
  }
  return lines
}
