import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { listVatFilings } from '@/lib/vat/filing-record-store'
import { resolveCompanyEntityType, resultClosingAccounts } from '@/lib/company/entity-type'
import { isYearEndAccount } from '@/lib/bookkeeping/bas-data/result-accounts'
import { resolvePeriodLockForDate } from '@/lib/core/bookkeeping/period-status'
import { mappingsToMap } from './account-mapper'
import { closedPeriodRefusal, prepareSIEVouchers } from './sie-import'
import { getEffectiveOpeningBalances } from './sie-parser'
import { appendOpeningBalanceDifferences } from './sie-continuity'
import type { SIEPreparedEntry } from './sie-job-contract'
import type { AccountMapping, OpeningBalanceDifference, ParsedSIEFile, SIEVoucher } from './types'

/**
 * Top up an imported fiscal year with only the file's new vouchers (issue
 * #108; crm#1338, crm#1297, crm#1049).
 *
 * A company that switches system mid-year keeps booking the last weeks in
 * the old system, and a card provider, payroll or POS system exports its own
 * verifikat as a SIE 4I file for a year that is already imported. The append
 * is its own import batch beside the year's import (its base), written by the
 * same job and writer as any import (write_sie_job_entries), so voucher
 * numbers continue in each series and no posted entry is touched. It undoes
 * alone; the base cannot be undone or replaced while an append is live.
 *
 * Every file voucher gets one verdict, from the books (sie_append_plan,
 * migration 20261030131447):
 *
 *   present             same source series and number, same content: skipped
 *   conflict            same source series and number, other content: the
 *                       whole append is refused with the list (a top-up
 *                       cannot change history; replacing the year can)
 *   possible_duplicate  no such source number, but a posted entry on the
 *                       same date with the same lines: skipped unless the
 *                       user includes it
 *   new                 added
 *
 * Refused as a whole besides: an #IB that differs from what the year opens
 * on, a new voucher that does not balance to the öre (no 1 kr öresutjämning,
 * a top-up must match its source) or uses an unmapped account, and a new
 * voucher dated in a closed or locked year or behind the company lock date.
 * #UB and #RES are never booked. Warnings: a filed VAT period gets new
 * vouchers; year-end vouchers (88xx, 89xx, the form's result account) land
 * while the next year already has a posted IB.
 *
 * The plan runs on the same rule in the preview (the wizard's append-plan
 * route, the MCP preflight and staging), at submit (submitSIEJob refuses
 * before anything is archived or queued) and in the job's preparation per
 * voucher group, which decides what is written: the books can change between
 * preview and job, and the job's plan is the one that holds.
 */

export type SIEAppendVerdict = 'present' | 'conflict' | 'possible_duplicate' | 'new'

export interface SIEAppendVerdictRow {
  sourceOrdinal: number
  verdict: SIEAppendVerdict
  entryId: string | null
  /** The booked verifikat the voucher matched, e.g. "A12". */
  voucher: string | null
}

export interface SIEAppendVoucher {
  sourceOrdinal: number
  /** The voucher's source reference ("A12"; "#5" without a number). */
  sourceId: string
  date: string
  description: string
  /** Sum of the debits, kronor. */
  amount: number
  verdict: SIEAppendVerdict
  /** Booked as (after the series map). */
  series: string
  /** The booked verifikat it matched (present, conflict, possible_duplicate). */
  matchedVoucher: string | null
  /** Carries a year-end line (88xx, 89xx or the form's result account). */
  yearEnd: boolean
}

export interface SIEAppendSeries {
  /** The series the file's vouchers would be booked in (the file's own, or the default for series-less ones). */
  source: string
  /** The series they are booked in. */
  target: string
  /** The year already uses `source`. */
  exists: boolean
  vouchers: number
}

export interface SIEAppendRefusal {
  code:
    | 'SIE_IMPORT_APPEND_NO_BASE'
    | 'SIE_IMPORT_APPEND_CONFLICT'
    | 'SIE_IMPORT_APPEND_OPENING_BALANCE_DIFFERS'
    | 'SIE_IMPORT_APPEND_INVALID_VOUCHERS'
    | 'SIE_IMPORT_APPEND_NOTHING_NEW'
    | 'SIE_IMPORT_PERIOD_LOCKED'
  /** Finished Swedish sentence naming what is in the way. */
  message: string
  details: Record<string, unknown>
}

export interface SIEAppendPlan {
  fiscalPeriodId: string | null
  baseImportId: string | null
  fiscalYear: { start: string; end: string } | null
  counts: { total: number; present: number; conflicts: number; possibleDuplicates: number; new: number; toAdd: number }
  /** Every voucher that is not already booked, in file order (at most LIST_LIMIT). */
  vouchers: SIEAppendVoucher[]
  vouchersTruncated: boolean
  series: SIEAppendSeries[]
  /** The series the year already uses: where a new series can be mapped to. */
  yearSeries: string[]
  /** Swedish. */
  warnings: string[]
  refusal: SIEAppendRefusal | null
}

export interface SIEAppendOptions {
  includePossibleDuplicates?: boolean
  seriesMap?: Record<string, string>
}

const LIST_LIMIT = 500
const NAMED_LIMIT = 10
/** Placeholder batch id for the preview: the content hash leaves it out. */
const PREVIEW_IMPORT_ID = '00000000-0000-0000-0000-000000000000'
/** Bound one sie_append_plan request below the job's 1 MB chunk. */
const PLAN_REQUEST_BYTES = 900_000
const PLAN_REQUEST_ENTRIES = 1_000

function named(refs: string[]): string {
  const shown = refs.slice(0, NAMED_LIMIT).join(', ')
  return refs.length > NAMED_LIMIT ? `${shown} och ${refs.length - NAMED_LIMIT} till` : shown
}

/** The file voucher's own balance, mapped lines only: exactly zero under roundOre, or not. */
export function appendVoucherImbalance(voucher: Pick<SIEVoucher, 'lines'>, accountMap: ReadonlyMap<string, string>): number {
  let sum = 0
  for (const line of voucher.lines) {
    if (!accountMap.get(line.account)) continue
    sum = roundOre(sum + roundOre(line.amount))
  }
  return sum
}

/**
 * The verdicts for prepared entries, read from the books in bounded requests.
 * `program` is the file's #PROGRAM: a source number is matched only within
 * batches of the same program.
 */
export async function readSIEAppendVerdicts(
  supabase: SupabaseClient,
  companyId: string,
  periodId: string,
  program: string | null,
  entries: SIEPreparedEntry[],
): Promise<Map<number, SIEAppendVerdictRow>> {
  const verdicts = new Map<number, SIEAppendVerdictRow>()
  let batch: SIEPreparedEntry[] = []
  let bytes = 2
  const flush = async () => {
    if (!batch.length) return
    const { data, error } = await supabase.rpc('sie_append_plan', {
      p_company_id: companyId, p_period_id: periodId, p_source_program: program, p_entries: batch,
    })
    if (error) throw new Error(`SIE append plan failed: ${error.message}`)
    for (const row of (data ?? []) as SIEAppendVerdictRow[]) verdicts.set(row.sourceOrdinal, row)
    batch = []
    bytes = 2
  }
  for (const entry of entries) {
    const size = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1
    if (batch.length && (bytes + size > PLAN_REQUEST_BYTES || batch.length >= PLAN_REQUEST_ENTRIES)) await flush()
    batch.push(entry)
    bytes += size
  }
  await flush()
  return verdicts
}

export interface SIEAppendGroupResult {
  /** The entries to write, the series map applied. */
  entries: SIEPreparedEntry[]
  present: number
  possibleDuplicatesSkipped: number
  possibleDuplicatesIncluded: number
  conflicts: Array<{ sourceId: string; voucher: string | null }>
  invalid: Array<{ sourceId: string; reason: 'unbalanced' | 'unmapped' }>
}

/**
 * What one group of prepared entries contributes to an append: the verdicts
 * applied, the strict balance checked on what would be written, the series
 * map applied. Pure; the job throws on conflicts or invalid vouchers.
 */
export function selectSIEAppendEntries(
  entries: SIEPreparedEntry[],
  verdicts: ReadonlyMap<number, SIEAppendVerdictRow>,
  voucherAt: (sourceOrdinal: number) => Pick<SIEVoucher, 'lines'> | undefined,
  accountMap: ReadonlyMap<string, string>,
  options: Pick<SIEAppendOptions, 'includePossibleDuplicates' | 'seriesMap'>,
): SIEAppendGroupResult {
  const result: SIEAppendGroupResult = { entries: [], present: 0, possibleDuplicatesSkipped: 0,
    possibleDuplicatesIncluded: 0, conflicts: [], invalid: [] }
  for (const entry of entries) {
    const verdict = verdicts.get(entry.sourceOrdinal)
    if (!verdict) throw new Error(`SIE append plan has no verdict for ${entry.sourceId}`)
    if (verdict.verdict === 'present') { result.present++; continue }
    if (verdict.verdict === 'conflict') { result.conflicts.push({ sourceId: entry.sourceId, voucher: verdict.voucher }); continue }
    if (verdict.verdict === 'possible_duplicate') {
      if (!options.includePossibleDuplicates) { result.possibleDuplicatesSkipped++; continue }
      result.possibleDuplicatesIncluded++
    }
    const voucher = voucherAt(entry.sourceOrdinal)
    if (!voucher || appendVoucherImbalance(voucher, accountMap) !== 0) {
      result.invalid.push({ sourceId: entry.sourceId, reason: 'unbalanced' })
      continue
    }
    // An append holds no numbers for skipped vouchers (crm#1599): its numbers
    // continue the year's series, and a skipped voucher may be one the books
    // already hold (cancelled in the source after it was imported), which
    // only the books could tell. A hold here could document a booked voucher
    // as never booked.
    const { numberGap: _held, ...appended } = entry
    const target = options.seriesMap?.[entry.series]
    result.entries.push(target && target !== entry.series ? { ...appended, series: target } : appended)
  }
  return result
}

/** The skipped vouchers an append cannot leave out: an unmapped account or an unbalanced one. */
export function invalidSkippedVouchers(skipped: ReturnType<typeof prepareSIEVouchers>['skippedDetails']): SIEAppendGroupResult['invalid'] {
  return skipped.flatMap((s): SIEAppendGroupResult['invalid'] => s.reason === 'unmapped'
    ? [{ sourceId: s.voucherId, reason: 'unmapped' }]
    : s.reason === 'unbalanced' || s.reason === 'single_line' ? [{ sourceId: s.voucherId, reason: 'unbalanced' }] : [])
}

export function appendConflictRefusal(conflicts: SIEAppendGroupResult['conflicts']): SIEAppendRefusal {
  return {
    code: 'SIE_IMPORT_APPEND_CONFLICT',
    message: `${conflicts.length} av filens verifikationer har samma nummer som bokförda verifikationer men annat innehåll: ` +
      `${named(conflicts.map(c => c.voucher && c.voucher !== c.sourceId ? `${c.sourceId} (bokförd som ${c.voucher})` : c.sourceId))}. ` +
      'En påfyllnad lägger bara till nya verifikationer och ändrar aldrig bokförda. Är filen den rätta: ersätt räkenskapsårets import i stället.',
    details: { conflicts: conflicts.slice(0, 200) },
  }
}

export function appendInvalidRefusal(invalid: SIEAppendGroupResult['invalid']): SIEAppendRefusal {
  const unmapped = invalid.filter(v => v.reason === 'unmapped').map(v => v.sourceId)
  const unbalanced = invalid.filter(v => v.reason === 'unbalanced').map(v => v.sourceId)
  return {
    code: 'SIE_IMPORT_APPEND_INVALID_VOUCHERS',
    message: [
      unbalanced.length ? `${unbalanced.length} nya verifikationer balanserar inte på öret: ${named(unbalanced)}.` : '',
      unmapped.length ? `${unmapped.length} nya verifikationer har konton utan mappning: ${named(unmapped)}.` : '',
      'En påfyllnad bokför verifikationerna exakt som i källsystemet. Rätta dem där eller mappa kontona, och försök igen.',
    ].filter(Boolean).join(' '),
    details: { vouchers: invalid.slice(0, 200) },
  }
}

export function appendNothingNewRefusal(present: number, skippedDuplicates: number): SIEAppendRefusal {
  return {
    code: 'SIE_IMPORT_APPEND_NOTHING_NEW',
    message: skippedDuplicates
      ? `Filen innehåller inga nya verifikationer: ${present} är redan bokförda och ${skippedDuplicates} ser ut som dubbletter av bokförda. Ta med de möjliga dubbletterna om de ska bokföras.`
      : `Filen innehåller inga nya verifikationer: alla ${present} är redan bokförda.`,
    details: { present, possible_duplicates: skippedDuplicates },
  }
}

function openingBalanceRefusal(differences: OpeningBalanceDifference[]): SIEAppendRefusal {
  const accounts = differences.map(d => `${d.account} (filen ${d.file}, bokfört ${d.books})`)
  return {
    code: 'SIE_IMPORT_APPEND_OPENING_BALANCE_DIFFERS',
    message: `Filens ingående balans skiljer sig från räkenskapsårets bokförda på ${differences.length} konton: ${named(accounts)}. ` +
      'En påfyllnad kan inte ändra ingående balansen. Är filen den rätta: rätta ingående balansen eller ersätt räkenskapsårets import.',
    details: { differences: differences.slice(0, 200) },
  }
}

function lockDateRefusal(lockedThrough: string, first: string): SIEAppendRefusal {
  return {
    code: 'SIE_IMPORT_PERIOD_LOCKED',
    message: `Bokföringen är låst t.o.m. ${lockedThrough}, och filens första nya verifikation är daterad ${first}. ` +
      'Lås upp under Inställningar > Bokföring (Bokföring låst t.o.m.) och försök igen. Lås bokföringen igen när verifikationerna är tillagda.',
    details: { locked_through: lockedThrough, first_voucher_date: first },
  }
}

function emptyPlan(refusal: SIEAppendRefusal, fields: Partial<SIEAppendPlan> = {}): SIEAppendPlan {
  return { fiscalPeriodId: null, baseImportId: null, fiscalYear: null,
    counts: { total: 0, present: 0, conflicts: 0, possibleDuplicates: 0, new: 0, toAdd: 0 },
    vouchers: [], vouchersTruncated: false, series: [], yearSeries: [], warnings: [], refusal, ...fields }
}

interface PeriodRow {
  id: string; name: string; period_start: string; period_end: string; is_closed: boolean | null
  locked_at: string | null; closed_externally: boolean | null; closing_entry_id: string | null
}

/** The year's completed import an append adds to, or null. Never an append itself. */
async function findSIEAppendBase(supabase: SupabaseClient, companyId: string, periodId: string): Promise<string | null> {
  const { data, error } = await supabase.from('sie_imports').select('id')
    .eq('company_id', companyId).eq('fiscal_period_id', periodId).eq('job_kind', 'import')
    .eq('job_state', 'completed').is('base_import_id', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as { id: string } | null)?.id ?? null
}

/**
 * The preview and submit-time verdict for appending `parsed` to the year it
 * belongs to. Read-only. `parsed` must carry its fiscal year (resolveSIEFiscalYear).
 */
export async function planSIEAppend(
  supabase: SupabaseClient,
  companyId: string,
  parsed: ParsedSIEFile,
  mappings: AccountMapping[],
  options: SIEAppendOptions = {},
): Promise<SIEAppendPlan> {
  const start = parsed.stats.fiscalYearStart
  const end = parsed.stats.fiscalYearEnd
  const noBase = (message: string): SIEAppendPlan => emptyPlan({ code: 'SIE_IMPORT_APPEND_NO_BASE', message, details: {} })
  if (!start || !end) return noBase('SIE-filen saknar räkenskapsår.')
  const { data: periodData, error: periodError } = await supabase.from('fiscal_periods')
    .select('id,name,period_start,period_end,is_closed,locked_at,closed_externally,closing_entry_id')
    .eq('company_id', companyId).lte('period_start', start).gte('period_end', end).limit(1).maybeSingle()
  if (periodError) throw new Error(periodError.message)
  const period = periodData as PeriodRow | null
  if (!period) return noBase(`Det finns inget räkenskapsår för ${start} till ${end} att lägga till verifikationer i. Importera filen som en vanlig import.`)
  const fiscalYear = { start: period.period_start, end: period.period_end }
  const baseImportId = await findSIEAppendBase(supabase, companyId, period.id)
  if (!baseImportId) {
    return emptyPlan({ code: 'SIE_IMPORT_APPEND_NO_BASE', details: { fiscal_period_id: period.id },
      message: `Räkenskapsåret ${period.name} har ingen färdig SIE-import att lägga till verifikationer i. Importera filen som en vanlig import.` },
    { fiscalPeriodId: period.id, fiscalYear })
  }
  const located = { fiscalPeriodId: period.id, baseImportId, fiscalYear }
  const closed = closedPeriodRefusal(period)
  if (closed) return emptyPlan({ code: 'SIE_IMPORT_PERIOD_LOCKED', message: closed, details: { fiscal_period_id: period.id } }, located)

  const accountMap = mappingsToMap(mappings)
  const chart = await fetchAllRows<{ id: string; account_number: string }>(({ from, to }) => supabase.from('chart_of_accounts')
    .select('id,account_number').eq('company_id', companyId).order('account_number').range(from, to))
  const accountIds = new Map(chart.map(row => [row.account_number, row.id]))
  // A voucher without a series is booked in B, the job's fallback with no
  // voucherSeries (an append seals none); the series map moves it.
  const prepared = prepareSIEVouchers(parsed, accountMap, 'B', PREVIEW_IMPORT_ID, { startOrdinal: 0, accountIds })
  const verdicts = await readSIEAppendVerdicts(supabase, companyId, period.id, parsed.header.program ?? null,
    prepared.preparedEntries)
  const selection = selectSIEAppendEntries(prepared.preparedEntries, verdicts, ordinal => parsed.vouchers[ordinal],
    accountMap, options)
  const invalid = [...invalidSkippedVouchers(prepared.skippedDetails), ...selection.invalid]

  const resultAccount = resultClosingAccounts(await resolveCompanyEntityType(supabase, companyId)).closing
  const toAdd = new Set(selection.entries.map(entry => entry.sourceOrdinal))
  const vouchers: SIEAppendVoucher[] = []
  for (const entry of prepared.preparedEntries) {
    const verdict = verdicts.get(entry.sourceOrdinal)!
    if (verdict.verdict === 'present') continue
    vouchers.push({
      sourceOrdinal: entry.sourceOrdinal, sourceId: entry.sourceId, date: entry.date, description: entry.description,
      amount: roundOre(entry.lines.reduce((sum, line) => sum + line.debit_amount, 0)), verdict: verdict.verdict,
      series: options.seriesMap?.[entry.series] ?? entry.series, matchedVoucher: verdict.voucher,
      yearEnd: entry.lines.some(line => isYearEndAccount(line.account_number, resultAccount)),
    })
  }
  const counts = {
    total: parsed.vouchers.length,
    present: selection.present,
    conflicts: selection.conflicts.length,
    possibleDuplicates: selection.possibleDuplicatesSkipped + selection.possibleDuplicatesIncluded,
    new: vouchers.filter(v => v.verdict === 'new').length,
    toAdd: selection.entries.length,
  }

  const existingSeries = new Set((await fetchAllRows<{ voucher_series: string }>(({ from, to }) => supabase
    .from('voucher_sequences').select('voucher_series').eq('company_id', companyId).eq('fiscal_period_id', period.id)
    .order('voucher_series').range(from, to))).map(row => row.voucher_series))
  const bySeries = new Map<string, number>()
  for (const entry of prepared.preparedEntries) if (toAdd.has(entry.sourceOrdinal)) bySeries.set(entry.series, (bySeries.get(entry.series) ?? 0) + 1)
  const series = [...bySeries].sort(([a], [b]) => a.localeCompare(b, 'sv'))
    .map(([source, count]) => ({ source, target: options.seriesMap?.[source] ?? source, exists: existingSeries.has(source), vouchers: count }))

  const plan: SIEAppendPlan = { ...located, counts, vouchers: vouchers.slice(0, LIST_LIMIT),
    vouchersTruncated: vouchers.length > LIST_LIMIT, series,
    yearSeries: [...existingSeries].sort((a, b) => a.localeCompare(b, 'sv')), warnings: [], refusal: null }

  if (selection.conflicts.length) return { ...plan, refusal: appendConflictRefusal(selection.conflicts) }
  if (getEffectiveOpeningBalances(parsed).balances.length) {
    const differences = await appendOpeningBalanceDifferences(supabase, companyId,
      { periodId: period.id, start: period.period_start }, parsed, mappings)
    if (differences.length) return { ...plan, refusal: openingBalanceRefusal(differences) }
  }
  if (invalid.length) return { ...plan, refusal: appendInvalidRefusal(invalid) }
  if (!selection.entries.length) {
    return { ...plan, refusal: appendNothingNewRefusal(selection.present, selection.possibleDuplicatesSkipped) }
  }

  // The company lock date, read as the triggers read it. The year itself was
  // checked above with the import's own sentence.
  const dates = selection.entries.map(entry => entry.date).sort()
  const lock = await resolvePeriodLockForDate(supabase, companyId, dates[0])
  if (lock.status.lookup_failed) throw new Error('SIE append plan: the company lock date could not be read')
  if (lock.layer === 'company_lock_date') return { ...plan, refusal: lockDateRefusal(lock.status.lock_date ?? dates[0], dates[0]) }

  plan.warnings.push(...await appendWarnings(supabase, companyId, period, dates, vouchers.filter(v => toAdd.has(v.sourceOrdinal))))
  return plan
}

async function appendWarnings(
  supabase: SupabaseClient,
  companyId: string,
  period: PeriodRow,
  dates: string[],
  added: SIEAppendVoucher[],
): Promise<string[]> {
  const warnings: string[] = []
  const filings = await listVatFilings(supabase, companyId)
  for (const filing of filings.sort((a, b) => a.period_start.localeCompare(b.period_start))) {
    const inside = dates.filter(date => date >= filing.period_start && date <= filing.period_end).length
    if (!inside) continue
    warnings.push(`Momsdeklarationen för ${filing.tax_period} är redan inlämnad, och ${inside} av de nya verifikationerna ` +
      'hamnar i den perioden. Kontrollera om deklarationen behöver rättas.')
  }
  const yearEnd = added.filter(v => v.yearEnd)
  if (yearEnd.length) {
    const { data: next, error } = await supabase.from('fiscal_periods').select('id,name,opening_balance_entry_id')
      .eq('company_id', companyId).gt('period_start', period.period_end).order('period_start', { ascending: true })
      .limit(1).maybeSingle()
    if (error) throw new Error(error.message)
    const nextYear = next as { name: string; opening_balance_entry_id: string | null } | null
    if (nextYear?.opening_balance_entry_id) {
      warnings.push(`${yearEnd.length} av de nya verifikationerna är bokslutsverifikationer (${named(yearEnd.map(v => v.sourceId))}). ` +
        `Räkenskapsåret ${nextYear.name} har redan en bokförd ingående balans, som inte längre stämmer med årets utgående ` +
        `balans när de är tillagda. Rätta den ingående balansen för ${nextYear.name} efteråt (med följdändring till senare år).`)
    }
  }
  return warnings
}

