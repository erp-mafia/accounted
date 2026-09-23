/**
 * Merge several parsed SIE files (one per fiscal year) into one
 * whole-dataset view.
 *
 * Mid-year provider exports have few or zero vouchers in the newest fiscal
 * year, so any preview or visualization built from a single file lies about
 * the dataset. The merged parse is for whole-dataset PRESENTATION (account
 * mapping, import preview counts, the migration theater model): the actual
 * import still runs per raw file.
 *
 * Semantics:
 * - accounts: union by number, first occurrence wins the name; missing
 *   sruCode/accountType are filled in from later duplicates.
 * - vouchers: concatenated in file order (callers pass files oldest first).
 * - opening/closing/result balances: concatenated AS-IS. Each record keeps
 *   the yearIndex relative to its SOURCE file's current year, so per-year
 *   balance math on the merged output is not meaningful: two files can both
 *   carry yearIndex 0 records for different calendar years.
 * - header.fiscalYears: union deduped by start+end, sorted oldest first,
 *   re-indexed so the newest year is 0 (stats then reports the newest
 *   year's bounds, matching the single-file "current year" convention).
 * - company name/orgnr: the most common non-empty value, first seen wins
 *   ties.
 * - dimensions: deduped by dimension number; dimension values deduped by
 *   (dimension number, code); first occurrence wins.
 * - issues: concatenated.
 *
 * Pure and browser-clean (no Node APIs): the client calls it too.
 */

import type {
  FiscalYearInfo,
  ParsedSIEFile,
  SIEAccount,
  SIEDimension,
  SIEDimensionValue,
} from './types'

/** Most common non-empty value; earlier values win ties. */
function mostCommon(values: (string | null)[]): string | null {
  const counts = new Map<string, number>()
  let best: string | null = null
  let bestCount = 0
  for (const value of values) {
    if (!value) continue
    const count = (counts.get(value) ?? 0) + 1
    counts.set(value, count)
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  return best
}

function firstNonNull<T>(values: (T | null | undefined)[]): T | null {
  for (const value of values) {
    if (value !== null && value !== undefined) return value
  }
  return null
}

export function mergeParsedSIEFiles(files: ParsedSIEFile[]): ParsedSIEFile {
  if (files.length === 0) {
    throw new Error('mergeParsedSIEFiles requires at least one parsed file')
  }
  if (files.length === 1) return files[0]

  const headers = files.map((f) => f.header)

  // Fiscal years: union by period, oldest first, newest re-indexed to 0.
  const yearsByPeriod = new Map<string, FiscalYearInfo>()
  for (const header of headers) {
    for (const fy of header.fiscalYears) {
      const key = `${fy.start}|${fy.end}`
      if (!yearsByPeriod.has(key)) yearsByPeriod.set(key, fy)
    }
  }
  const sortedYears = [...yearsByPeriod.values()].sort((a, b) =>
    a.start.localeCompare(b.start),
  )
  const fiscalYears = sortedYears.map((fy, i) => ({
    yearIndex: i - (sortedYears.length - 1),
    start: fy.start,
    end: fy.end,
  }))

  // Accounts: union by number, first name wins, missing metadata filled in.
  const accountsByNumber = new Map<string, SIEAccount>()
  for (const file of files) {
    for (const account of file.accounts) {
      const existing = accountsByNumber.get(account.number)
      if (!existing) {
        accountsByNumber.set(account.number, { ...account })
      } else {
        if (!existing.sruCode && account.sruCode) existing.sruCode = account.sruCode
        if (!existing.accountType && account.accountType) {
          existing.accountType = account.accountType
        }
      }
    }
  }
  const accounts = [...accountsByNumber.values()]

  // Dimension registry: dedupe by identity, first occurrence wins.
  const dimensionsByNo = new Map<number, SIEDimension>()
  const dimensionValuesByKey = new Map<string, SIEDimensionValue>()
  for (const file of files) {
    for (const dim of file.dimensions) {
      if (!dimensionsByNo.has(dim.sieDimNo)) dimensionsByNo.set(dim.sieDimNo, dim)
    }
    for (const value of file.dimensionValues) {
      const key = `${value.sieDimNo}|${value.code}`
      if (!dimensionValuesByKey.has(key)) dimensionValuesByKey.set(key, value)
    }
  }

  const vouchers = files.flatMap((f) => f.vouchers)
  const currentFiscalYear = fiscalYears.find((fy) => fy.yearIndex === 0)

  return {
    header: {
      sieType: files.reduce(
        (max, f) => (f.header.sieType > max ? f.header.sieType : max),
        files[0].header.sieType,
      ),
      // Any file flagged as already imported taints the merged view.
      flagga: headers.some((h) => h.flagga === 1)
        ? 1
        : firstNonNull(headers.map((h) => h.flagga)),
      program: firstNonNull(headers.map((h) => h.program)),
      programVersion: firstNonNull(headers.map((h) => h.programVersion)),
      generatedDate: firstNonNull(headers.map((h) => h.generatedDate)),
      format: firstNonNull(headers.map((h) => h.format)),
      companyName: mostCommon(headers.map((h) => h.companyName)),
      orgNumber: mostCommon(headers.map((h) => h.orgNumber)),
      address: firstNonNull(headers.map((h) => h.address)),
      fiscalYears,
      currency: firstNonNull(headers.map((h) => h.currency || null)) ?? 'SEK',
      kontoPlanType: firstNonNull(headers.map((h) => h.kontoPlanType)),
    },
    accounts,
    openingBalances: files.flatMap((f) => f.openingBalances),
    closingBalances: files.flatMap((f) => f.closingBalances),
    resultBalances: files.flatMap((f) => f.resultBalances),
    vouchers,
    dimensions: [...dimensionsByNo.values()],
    dimensionValues: [...dimensionValuesByKey.values()],
    issues: files.flatMap((f) => f.issues),
    stats: {
      totalAccounts: accounts.length,
      totalVouchers: vouchers.length,
      totalTransactionLines: vouchers.reduce((sum, v) => sum + v.lines.length, 0),
      fiscalYearStart: currentFiscalYear?.start ?? null,
      fiscalYearEnd: currentFiscalYear?.end ?? null,
    },
  }
}
