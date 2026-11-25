import type { SupabaseClient } from '@supabase/supabase-js'
import { SIEJobMappingsSchema } from '@/lib/api/schemas'
import { whereSieImportInPlace } from '@/lib/bookkeeping/sie-import-in-place'
import { mappingsToMap } from '@/lib/import/account-mapper'
import type { SIEJob } from '@/lib/import/sie-job-contract'
import { applySIEFiscalYear, readSIEJobSource } from '@/lib/import/sie-jobs'
import { getEffectiveOpeningBalances, isBalanceSheetAccount, parseSIEFile } from '@/lib/import/sie-parser'
import type { AccountMapping, ParsedSIEFile } from '@/lib/import/types'
import { createLogger } from '@/lib/logger'
import { isZeroOre, roundOre, sumOre } from '@/lib/money'
import type { TrialBalanceRow } from '@/types'

const log = createLogger('arsredovisning/balance-file-year')

/**
 * A finished year that came in as an SIE balance file: a file with #IB, #UB
 * and #RES for the year and no #VER. The import books its opening balances
 * and nothing else, so the year's own books end where they began and its
 * result is 0. The annual report of the next year reads its comparison
 * figures (ÅRL 3 kap. 5 §) from the file instead; nothing is booked in the
 * year.
 */
export interface BalanceFileYearPair {
  /** A TrialBalancePair, with the rows generateTrialBalance gives. */
  full: TrialBalanceRow[]
  preClosing: TrialBalanceRow[]
}

/** What the year's import gives: its figures, why it cannot, or a failed read. */
export type BalanceFileYearReading =
  | { kind: 'read'; filename: string; pair: BalanceFileYearPair }
  | { kind: 'not_used'; filename: string; reason: string }
  | { kind: 'failed'; filename: string }

/** A year with no activity in the books: at most its ingående balans. */
export function holdsOnlyOpeningBalances(rows: readonly TrialBalanceRow[]): boolean {
  return rows.every((row) => isZeroOre(row.period_debit) && isZeroOre(row.period_credit))
}

/**
 * The year's trial balance as it would stand had the source system's
 * verifikat been booked: each account opens as the books open and moves as
 * the file says the year moved it, #UB 0 less the opening balance the import
 * read (getEffectiveOpeningBalances) on a balance sheet account, #RES 0 on a
 * result account. Mapped as the import mapped the file. The books must open
 * on the file's #IB, or the close is not the file's #UB: the one difference
 * allowed is what the import added to an unbalanced file's ingående balans
 * on `differenceAccount` (the form's result-closing account), which stays
 * where it was booked.
 *
 * A refusal, in words for the report, when the file cannot give the year:
 * it has verifikat, lacks #UB, is another year, moves an account without a
 * target, does not balance, or the books open on other balances than it.
 * A file without #RES is a year without result, as a dormant year is.
 */
export function balanceFileYearTrialBalance(
  parsed: ParsedSIEFile,
  accountMap: ReadonlyMap<string, string>,
  booksRows: readonly TrialBalanceRow[],
  period: { period_start: string; period_end: string },
  differenceAccount?: string,
): { pair: BalanceFileYearPair } | { refusal: string } {
  if (parsed.vouchers.length > 0) {
    return { refusal: 'filen har verifikationer, och de är inte bokförda i Accounted' }
  }
  const closingBalances = parsed.closingBalances.filter((b) => b.yearIndex === 0)
  const resultBalances = parsed.resultBalances.filter((b) => b.yearIndex === 0)
  if (closingBalances.length === 0) {
    return { refusal: 'filen saknar utgående balanser (#UB) för året' }
  }
  const { fiscalYearStart, fiscalYearEnd } = parsed.stats
  if (fiscalYearStart !== period.period_start || fiscalYearEnd !== period.period_end) {
    return { refusal: `filens räkenskapsår (${fiscalYearStart ?? '?'} till ${fiscalYearEnd ?? '?'}) är ett annat än årets` }
  }

  // Per source account: what the year moved it by, as the import reconciles
  // a year (sie-import.ts): #UB less #IB on balance sheet accounts, #RES on
  // result accounts.
  const movementBySource = new Map<string, number>()
  const addSource = (account: string, amount: number) =>
    movementBySource.set(account, roundOre((movementBySource.get(account) ?? 0) + amount))
  const openingBalances = getEffectiveOpeningBalances(parsed).balances
  for (const b of openingBalances) if (isBalanceSheetAccount(b.account)) addSource(b.account, -b.amount)
  for (const b of closingBalances) if (isBalanceSheetAccount(b.account)) addSource(b.account, b.amount)
  for (const b of resultBalances) if (!isBalanceSheetAccount(b.account)) addSource(b.account, b.amount)

  const movement = new Map<string, number>()
  const names = new Map<string, string>()
  for (const [source, amount] of movementBySource) {
    if (isZeroOre(amount)) continue
    const target = accountMap.get(source)
    if (!target || isBalanceSheetAccount(target) !== isBalanceSheetAccount(source)) {
      return { refusal: `konto ${source} i filen har inget motsvarande konto i Accounted` }
    }
    movement.set(target, roundOre((movement.get(target) ?? 0) + amount))
    const name = parsed.accounts.find((account) => account.number === source)?.name
    if (name && !names.has(target)) names.set(target, name)
  }

  // The import may not have booked the file's #IB (a year continued from
  // the books, or one whose ingående balans was changed after): then the
  // books' opening plus the file's movement is not the file's close.
  const fileOpening = new Map<string, number>()
  for (const b of openingBalances) {
    const target = accountMap.get(b.account)
    if (target && isBalanceSheetAccount(target)) fileOpening.set(target, roundOre((fileOpening.get(target) ?? 0) + b.amount))
  }
  const books = new Map(booksRows.map((row) => [row.account_number, row]))
  for (const account of new Set([...books.keys(), ...fileOpening.keys()])) {
    if (account === differenceAccount) continue
    const booked = books.get(account)
    const opening = booked ? booked.opening_debit - booked.opening_credit : 0
    if (!isZeroOre(roundOre(opening - (fileOpening.get(account) ?? 0)))) {
      return { refusal: `årets ingående balans på konto ${account} i Accounted är en annan än filens` }
    }
  }

  const rows: TrialBalanceRow[] = []
  for (const account of [...new Set([...books.keys(), ...movement.keys()])].sort()) {
    const booked = books.get(account)
    const opening = booked ? roundOre(booked.opening_debit - booked.opening_credit) : 0
    const activity = movement.get(account) ?? 0
    if (isZeroOre(opening) && isZeroOre(activity)) continue
    const opening_debit = Math.max(opening, 0)
    const opening_credit = Math.max(-opening, 0)
    const period_debit = Math.max(activity, 0)
    const period_credit = Math.max(-activity, 0)
    rows.push({
      account_number: account,
      account_name: booked?.account_name || names.get(account) || account,
      account_class: Number(account[0]),
      opening_debit,
      opening_credit,
      period_debit,
      period_credit,
      closing_debit: roundOre(opening_debit + period_debit),
      closing_credit: roundOre(opening_credit + period_credit),
    })
  }
  // Within the öre the statements round away; a krona or more is a file
  // whose close does not follow from its opening.
  if (Math.abs(sumOre(rows.map((row) => row.closing_debit - row.closing_credit))) >= 1) {
    return { refusal: 'filens utgående balanser och resultat går inte jämnt ut mot dess ingående balanser' }
  }
  // The year has no closing entry in these books, so both variants are the same.
  return { pair: { full: rows, preClosing: rows } }
}

interface ImportRow {
  id: string
  company_id: string
  fiscal_period_id: string
  filename: string
  job_state: string | null
  manifest: Record<string, unknown> | null
  file_storage_path: string | null
  file_hash: string
}

/**
 * The SIE imports in place for `years`, finished years whose books hold no
 * activity (holdsOnlyOpeningBalances), each read from its archived file. A
 * year without an import in place is left out. Read-only. Throws only when
 * the imports cannot be listed; a file that cannot be read is 'failed'.
 */
export async function loadBalanceFileYears(
  supabase: SupabaseClient,
  companyId: string,
  years: ReadonlyArray<{ periodId: string; period_start: string; period_end: string; booksRows: TrialBalanceRow[] }>,
): Promise<Map<string, BalanceFileYearReading>> {
  const found = new Map<string, BalanceFileYearReading>()
  if (years.length === 0) return found
  const { data, error } = await whereSieImportInPlace(
    supabase
      .from('sie_imports')
      .select('id, company_id, fiscal_period_id, filename, job_state, manifest, file_storage_path, file_hash')
      .eq('company_id', companyId),
  ).in('fiscal_period_id', years.map((year) => year.periodId))
  if (error) throw new Error(`Failed to read the years' SIE imports: ${error.message}`)
  const imports = (data ?? []) as ImportRow[]

  for (const year of years) {
    const inPlace = imports.filter((row) => row.fiscal_period_id === year.periodId)
    if (inPlace.length === 0) continue
    const filename = inPlace.map((row) => row.filename).join(', ')
    if (inPlace.length > 1) {
      found.set(year.periodId, { kind: 'not_used', filename, reason: 'flera importer ligger kvar för året' })
      continue
    }
    const row = inPlace[0]
    // transactions_count is no test: it counts the import's own ingående
    // balans verifikat. The file's lack of #VER is.
    const input = row.manifest?.input as
      | { mappings?: unknown; sourceHash?: unknown; fiscalYear?: { start: string; end: string } }
      | undefined
    const mappings = SIEJobMappingsSchema.safeParse(input?.mappings)
    if (row.job_state !== 'completed' || !row.file_storage_path || input?.sourceHash !== row.file_hash || !mappings.success) {
      found.set(year.periodId, { kind: 'not_used', filename, reason: 'importens fil eller kontomappning finns inte sparad' })
      continue
    }
    try {
      const parsed = parseSIEFile(await readSIEJobSource(supabase, row as unknown as SIEJob))
      // A file without #RAR has the year the import gave it, as the import read it.
      applySIEFiscalYear(parsed, input.fiscalYear)
      const differenceAccount = row.manifest?.openingBalanceDifferenceAccount
      const result = balanceFileYearTrialBalance(
        parsed,
        mappingsToMap(mappings.data as AccountMapping[]),
        year.booksRows,
        year,
        typeof differenceAccount === 'string' ? differenceAccount : undefined,
      )
      found.set(
        year.periodId,
        'pair' in result
          ? { kind: 'read', filename, pair: result.pair }
          : { kind: 'not_used', filename, reason: result.refusal },
      )
    } catch (err) {
      log.error('balance file year: the archived SIE file could not be read', {
        companyId,
        importId: row.id,
        error: err instanceof Error ? err.message : String(err),
      })
      found.set(year.periodId, { kind: 'failed', filename })
    }
  }
  return found
}
