import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { formatCurrency } from '@/lib/utils'
import { ORE_TOLERANCE, roundOre } from '@/lib/money'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { getOpeningBalances } from '@/lib/reports/opening-balances'
import { findFiscalYearGaps, type PeriodLike } from '@/lib/bookkeeping/fiscal-year-gaps'
import { isBASEquityGroupAccount } from '@/lib/bookkeeping/bas-data/class-2-equity-liabilities'
import { mappingsToMap } from './account-mapper'
import { getEffectiveOpeningBalances, isBalanceSheetAccount } from './sie-parser'
import { makeNotice, type ImportNotice } from './notices'
import type {
  AccountMapping,
  BookedOpeningBalance,
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

/**
 * The file's own previous-year closing balance (#UB -1) per company account,
 * mapped and summed as fileOpeningBalanceByAccount maps the #IB; an account
 * the file leaves out closes at zero (SIE spec 5.17). Null when the file
 * states no #UB -1, or only zeros (a first year written out with empty rows):
 * books without earlier years would match it on every account.
 */
export function filePreviousClosingByAccount(
  closingBalances: readonly { account: string; amount: number; yearIndex: number }[],
  mappings: AccountMapping[],
): Map<string, number> | null {
  const previous = closingBalances.filter((balance) => balance.yearIndex === -1)
  if (previous.every((balance) => !(Math.abs(balance.amount) >= ORE_TOLERANCE))) return null
  return fileOpeningBalanceByAccount(previous.map((balance) => ({ ...balance, yearIndex: 0 })), mappings)
}

/**
 * Which side of an opening-balance difference is off (crm#1099). True when
 * the books differ from the file's #IB and open on the file's own #UB -1 on
 * every balance-sheet account: the books agree with the source system's
 * previous year, and it is the file's #IB that departs from that year. Two
 * causes leave this and the data cannot tell them apart: the previous year
 * changed after the source system created the year's #IB (the books' opening
 * is the right one), or the #IB was changed by hand there (that change is not
 * in the books). In the 30 days to 2026-11-12, 135 continuation imports
 * differed from the file's #IB on accounts outside equity, and every one was
 * told only "Stäm av mot källsystemet".
 *
 * `file.opening` must be the rows `differences` was computed from (the
 * effective #IB). Every account counts, not only the differing ones: where
 * the books equal the file's #IB, that #IB must equal the #UB -1 as well.
 *
 * Not covered, so the general reconcile text stays:
 * - differences only within equity (BAS kontogrupp 20): a program that moves
 *   2019 to 2010, or 2099 to 2098, in the new year's #IB, which neither cause
 *   describes;
 * - a #UB -1 without the previous year's result booked: the books carry that
 *   result on the result-closing account, so they differ from #UB -1 there.
 */
export function booksMatchFilePreviousYear(
  differences: readonly OpeningBalanceDifference[],
  file: {
    opening: readonly { account: string; amount: number; yearIndex?: number }[]
    closing: readonly { account: string; amount: number; yearIndex: number }[]
  },
  mappings: AccountMapping[],
): boolean {
  if (differences.every((row) => isBASEquityGroupAccount(row.account))) return false
  const previousClosing = filePreviousClosingByAccount(file.closing, mappings)
  if (!previousClosing) return false
  const opening = fileOpeningBalanceByAccount(file.opening, mappings)
  // compareOpeningBalances lists only the accounts where the books differ from
  // the file's #IB: everywhere else the books open on that #IB.
  const books = new Map(differences.map((row) => [row.account, row.books]))
  for (const account of new Set([...opening.keys(), ...previousClosing.keys(), ...books.keys()])) {
    if (!isBalanceSheetAccount(account)) continue
    const opensOn = books.get(account) ?? opening.get(account) ?? 0
    if (Math.abs(roundOre((previousClosing.get(account) ?? 0) - opensOn)) >= ORE_TOLERANCE) return false
  }
  return true
}

/**
 * What each cause booksMatchFilePreviousYear cannot tell apart means for the
 * books. It names no year to book a change in: that is the customer's call.
 */
const FILE_OPENING_OFF_CAUSES =
  'Om föregående år ändrades efter att det gamla programmet skapade årets ingående balans är det bokföringens ' +
  'ingående balans som stämmer. Om den ingående balansen ändrades för hand i det gamla programmet finns den ' +
  'ändringen inte i bokföringen; ska den med behöver den bokföras som en verifikation.'

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

/**
 * What the year opens on in the books against the file's #IB: the year's own
 * IB verifikat when it has one, otherwise the balance carried forward to its
 * first day.
 */
async function compareWithBooks(
  supabase: SupabaseClient,
  companyId: string,
  fiscalYearStart: string,
  fileBalances: readonly { account: string; amount: number; yearIndex?: number }[],
  mappings: AccountMapping[],
  openingBalanceEntryId: string | null = null,
): Promise<OpeningBalanceDifference[]> {
  // A file that states no opening balance has nothing to compare.
  if (fileBalances.length === 0) return []
  const { balances } = await getOpeningBalances(supabase, companyId, {
    period_start: fiscalYearStart,
    opening_balance_entry_id: openingBalanceEntryId,
  })
  return compareOpeningBalances(fileOpeningBalanceByAccount(fileBalances, mappings), balances)
}

/**
 * The posted IB verifikat a fiscal year opens on, when it has one
 * (fiscal_periods.opening_balance_entry_id: booked by hand, by the year-end
 * close, or by an earlier import). An import never books the file's IB on
 * top of it (sie_import_admission_refusal, crm#1272), so the file's IB is
 * compared with this verifikat, not with the balance earlier years carry
 * forward. An IB the replaced import booked does not count.
 */
async function findBookedOpeningBalance(
  supabase: SupabaseClient,
  companyId: string,
  year: { periodId: string } | { start: string; end: string },
  replacesImportId: string | null,
): Promise<BookedOpeningBalance | null> {
  const base = supabase.from('fiscal_periods').select('opening_balance_entry_id').eq('company_id', companyId)
  const { data: period, error } = await ('periodId' in year
    ? base.eq('id', year.periodId)
    : base.lte('period_start', year.start).gte('period_end', year.end)
  ).maybeSingle()
  if (error) throw new Error(error.message)
  const entryId = (period as { opening_balance_entry_id?: string | null } | null)?.opening_balance_entry_id
  if (!entryId) return null
  const { data: entry, error: entryError } = await supabase
    .from('journal_entries')
    .select('id, voucher_series, voucher_number, status, import_batch_id')
    .eq('company_id', companyId)
    .eq('id', entryId)
    .maybeSingle()
  if (entryError) throw new Error(entryError.message)
  const row = entry as {
    id: string
    voucher_series: string | null
    voucher_number: number | null
    status: string
    import_batch_id: string | null
  } | null
  if (!row || row.status !== 'posted') return null
  if (replacesImportId && row.import_batch_id === replacesImportId) return null
  return { entryId: row.id, voucher: formatVoucher(row) }
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
    const replacesImportId = options.replacesImportId ?? null
    const booked = await findBookedOpeningBalance(supabase, companyId, { start, end }, replacesImportId)
    const carriedForward = booked !== null || (await willCarryForward(supabase, companyId, end, replacesImportId))
    const opening = getEffectiveOpeningBalances(parsed).balances
    const differences = carriedForward
      ? await compareWithBooks(supabase, companyId, start, opening, mappings, booked?.entryId ?? null)
      : []
    const fileOpeningOff = booksMatchFilePreviousYear(differences, { opening, closing: parsed.closingBalances }, mappings)
    return {
      carriedForward,
      ...(booked ? { bookedOpeningBalance: booked } : {}),
      differences,
      ...(fileOpeningOff ? { fileOpeningOff } : {}),
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
 * read from the file's IB in the job manifest. With `fiscalPeriodId`, a year
 * that has its own IB verifikat is compared with it (crm#1272). Never throws:
 * a failed read costs the notice, not the import.
 */
export async function diagnoseCarriedForwardDifferences(
  supabase: SupabaseClient,
  companyId: string,
  fiscalYearStart: string,
  fileBalances: unknown,
  mappings: AccountMapping[],
  fiscalPeriodId?: string,
): Promise<OpeningBalanceDifference[]> {
  try {
    const booked = fiscalPeriodId
      ? await findBookedOpeningBalance(supabase, companyId, { periodId: fiscalPeriodId }, null)
      : null
    return await compareWithBooks(supabase, companyId, fiscalYearStart, storedOpeningBalances(fileBalances), mappings,
      booked?.entryId ?? null)
  } catch (err) {
    log.warn('opening-balance continuity check failed; the import is unaffected', {
      companyId,
      message: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

/**
 * An append to an imported year (sie-append.ts): the accounts where the
 * file's IB differs from what the year opens on in the books (its own IB
 * verifikat, else the balance carried forward). Unlike the diagnoses above it
 * throws on a failed read: the answer refuses or admits the append.
 */
export async function appendOpeningBalanceDifferences(
  supabase: SupabaseClient,
  companyId: string,
  year: { periodId: string; start: string },
  parsed: ParsedSIEFile,
  mappings: AccountMapping[],
): Promise<OpeningBalanceDifference[]> {
  const booked = await findBookedOpeningBalance(supabase, companyId, { periodId: year.periodId }, null)
  return compareWithBooks(supabase, companyId, year.start, getEffectiveOpeningBalances(parsed).balances, mappings,
    booked?.entryId ?? null)
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
  /** booksMatchFilePreviousYear: the file's #IB is the side that is off. */
  fileOpeningOff?: boolean
}): { warnings: string[]; notices: ImportNotice[] } {
  const warnings: string[] = []
  const notices: ImportNotice[] = []
  if (input.differences.length > 0) {
    const count = input.differences.length
    const accounts = count === 1 ? 'konto' : 'konton'
    const amount = sek(totalDifference(input.differences))
    if (input.fileOpeningOff) {
      // Still an action: only the customer can tell which cause it was.
      warnings.push(
        `Filens ingående balans skiljer sig från filens egen utgående balans för föregående år på ${count} ${accounts} ` +
          `(sammanlagt ${amount}). Bokföringens ingående balans stämmer med föregående års utgående balans i filen. ` +
          FILE_OPENING_OFF_CAUSES,
      )
      notices.push(makeNotice('sie_ib_file_differs_from_previous_year', 'action', { count, amount }))
    } else {
      warnings.push(
        `Ingående balans följer föregående års utgående balans och skiljer sig från filens ingående balans på ${count} ` +
          `${accounts} (sammanlagt ${amount}). Stäm av mot källsystemet.`,
      )
      notices.push(makeNotice('sie_ib_differs_from_file', 'action', { count, amount }))
    }
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
  if (continuity.differences.length > 0 && continuity.fileOpeningOff) {
    const opensOn = continuity.bookedOpeningBalance
      ? `räkenskapsåret har redan en bokförd ingående balans (verifikation ${continuity.bookedOpeningBalance.voucher})`
      : 'företaget har redan bokföring fram till räkenskapsårets slut, så året öppnar på föregående års utgående balans'
    // The file's IB is the subject here: its deviation is file minus books.
    const fileDeviations = continuity.differences.map((row) => ({ ...row, difference: roundOre(-row.difference) }))
    lines.push(
      `Filens ingående balans bokförs inte: ${opensOn}. Bokföringens ingående balans stämmer med föregående års ` +
        `utgående balans i filen; det är filens ingående balans som avviker från den, på ` +
        `${accountList(fileDeviations)}. ${FILE_OPENING_OFF_CAUSES}`,
    )
  } else if (continuity.differences.length > 0 && continuity.bookedOpeningBalance) {
    lines.push(
      `Filens ingående balans bokförs inte: räkenskapsåret har redan en bokförd ingående balans (verifikation ${continuity.bookedOpeningBalance.voucher}). ` +
        `Den skiljer sig från filen på ${accountList(continuity.differences)}. Stäm av mot källsystemet innan importen; ` +
        'är det filens ingående balans som stämmer, korrigera den bokförda.',
    )
  } else if (continuity.differences.length > 0) {
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
