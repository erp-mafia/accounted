/**
 * Tax table lookup via Skatteverket's open data API.
 *
 * Primary source: Skatteverket EntryScape rowstore API (no authentication).
 *   - Tax tables: https://skatteverket.entryscape.net/rowstore/dataset/88320397-5c32-4c16-ae79-d36d95b17b95
 *   - Kommun rates: https://skatteverket.entryscape.net/rowstore/dataset/c67b320b-ffee-4876-b073-dd9236cd2a99
 *
 * Emergency fallback: lib/salary/tax-tables-fallback.ts (generated from
 * Skatteverket's published TXT file: used only if the API is unreachable).
 *
 * Per Skatteförfarandelagen: Tax withholding must use the correct table/column
 * for each employee based on their folkbokföringskommun. No silent percentage
 * fallback is used: if neither the API nor the local fallback can serve the
 * requested data, the lookup throws. This prevents silent under-withholding.
 *
 * Results are cached in-memory per salary run calculation to avoid redundant
 * API calls (one call fetches all brackets for a table/column combination).
 */

import { createLogger } from '@/lib/logger'
import { FALLBACK_TAX_TABLES, FALLBACK_TAX_TABLE_YEARS } from './tax-tables-fallback'

const log = createLogger('tax-tables')

const TAX_TABLE_API = 'https://skatteverket.entryscape.net/rowstore/dataset/88320397-5c32-4c16-ae79-d36d95b17b95'
const KOMMUN_RATES_API = 'https://skatteverket.entryscape.net/rowstore/dataset/c67b320b-ffee-4876-b073-dd9236cd2a99'

export type TaxTableSource = 'api' | 'fallback'

interface TaxTableRateBase {
  tableYear: number
  tableNumber: number
  columnNumber: number
  incomeFrom: number
  incomeTo: number
}

/**
 * One bracket of a Skatteverket monthly tax table.
 *
 * Skatteverket's tables have two sections: krona brackets ("30B" rows, incomes
 * up to 80 000 kr/month) where the withholding is a fixed SEK amount, and
 * percent brackets ("30%" rows, incomes above) where the withholding is the
 * given percent of the WHOLE monthly income. The top percent bracket is
 * open-ended (no upper bound in the source data).
 */
export type TaxTableRate =
  | (TaxTableRateBase & { kind: 'amount'; taxAmount: number })
  | (TaxTableRateBase & { kind: 'percent'; taxPercent: number })

export interface TaxTableRatesResult {
  rates: TaxTableRate[]
  source: TaxTableSource
}

// In-memory cache: "year-table-column" → rates
interface CachedEntry {
  rates: TaxTableRate[]
  source: TaxTableSource
  fetchedAt: number
}
const rateCache = new Map<string, CachedEntry>()
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

/**
 * Thrown when tax table data is unavailable from both the API and local fallback.
 * Payroll calculation must fail loudly rather than silently under-withhold.
 */
export class TaxTableUnavailableError extends Error {
  constructor(
    message: string,
    public readonly context: { year: number; tableNumber: number; column: number }
  ) {
    super(message)
    this.name = 'TaxTableUnavailableError'
  }
}

/**
 * Look up tax amount for a given monthly income using Skatteverket's API.
 * Returns the tax amount in SEK and the data source used.
 */
export async function lookupTaxFromApi(
  tableNumber: number,
  column: number,
  monthlyIncome: number,
  year: number = new Date().getFullYear()
): Promise<{ taxAmount: number; source: TaxTableSource }> {
  const { rates, source } = await fetchTaxTableRates(year, tableNumber, column)
  return {
    taxAmount: lookupTaxAmount(tableNumber, column, monthlyIncome, rates),
    source,
  }
}

/**
 * Look up the tax amount from pre-loaded rates (pure function, no API call).
 *
 * Throws TaxTableUnavailableError if no rates match the requested table/column.
 * Callers must ensure rates have been loaded via fetchTaxTableRates first:
 * we deliberately avoid a silent percentage fallback because silent wrong
 * withholding is worse than loud failure.
 */
export function lookupTaxAmount(
  tableNumber: number,
  column: number,
  monthlyIncome: number,
  rates: TaxTableRate[]
): number {
  const roundedIncome = Math.round(monthlyIncome)

  const matchingRates = rates.filter(
    r => r.tableNumber === tableNumber && r.columnNumber === column
  )

  if (matchingRates.length === 0) {
    throw new TaxTableUnavailableError(
      `No tax table rates found for table ${tableNumber}, column ${column}. ` +
        `Ensure fetchTaxTableRates succeeded before calling lookupTaxAmount.`,
      { year: rates[0]?.tableYear ?? 0, tableNumber, column }
    )
  }

  matchingRates.sort((a, b) => a.incomeFrom - b.incomeFrom)

  for (const rate of matchingRates) {
    if (roundedIncome >= rate.incomeFrom && roundedIncome <= rate.incomeTo) {
      return taxForRate(rate, roundedIncome)
    }
  }

  // Last-resort guard. The top percent bracket is open-ended, so with fully
  // loaded rates this is unreachable; hitting it means the percent rows are
  // missing and clamping to the last krona bracket UNDER-withholds for high
  // incomes. Warn loudly so it surfaces in logs.
  const lastRate = matchingRates[matchingRates.length - 1]
  if (roundedIncome > lastRate.incomeTo) {
    log.warn(
      `Income ${roundedIncome} exceeds all loaded brackets for table ${tableNumber} col ${column} ` +
        `(top bracket ends at ${lastRate.incomeTo}): percent rows appear to be missing, clamping to last bracket`
    )
    return taxForRate(lastRate, roundedIncome)
  }

  // Income above the first bracket's start but inside no bracket means the
  // loaded rates have a gap (e.g. partial API data). Withholding 0 there would
  // be silent under-withholding: fail loudly instead.
  if (roundedIncome > matchingRates[0].incomeFrom) {
    throw new TaxTableUnavailableError(
      `Tax table ${tableNumber} column ${column} has no bracket covering income ${roundedIncome}: ` +
        `loaded rates contain a gap.`,
      { year: matchingRates[0].tableYear, tableNumber, column }
    )
  }

  // Below the first bracket: no withholding due.
  return 0
}

/**
 * Withholding for one matched bracket. Percent brackets apply their percent to
 * the whole monthly income; öre are dropped since skatteavdrag is stated in
 * whole kronor (öretal bortfaller: the whole-krona rule in SFF 2011:1261
 * 22 kap. 1 § as applied by Skatteverket's tabellavdrag guidance).
 */
function taxForRate(rate: TaxTableRate, roundedIncome: number): number {
  if (rate.kind === 'percent') {
    return Math.floor((roundedIncome * rate.taxPercent) / 100)
  }
  return rate.taxAmount
}

/**
 * Build TaxTableRate[] for a given year/table/column from the bundled fallback data.
 * Returns null when the requested year/table is not present in the fallback module.
 */
function getFallbackRates(
  year: number,
  tableNumber: number,
  column: number
): TaxTableRate[] | null {
  const yearTables = FALLBACK_TAX_TABLES[year]
  if (!yearTables) return null
  const rows = yearTables[tableNumber]
  if (!rows) return null
  if (column < 1 || column > 6) return null

  // Columns 1-6 map to tuple indices 2-7 ([incomeFrom, incomeTo, col1..col6, isPercent])
  const colIndex = column + 1
  return rows.map(row => {
    const base = {
      tableYear: year,
      tableNumber,
      columnNumber: column,
      incomeFrom: row[0],
      incomeTo: row[1] || 9999999,
    }
    return row[8] === 1
      ? { ...base, kind: 'percent' as const, taxPercent: row[colIndex] as number }
      : { ...base, kind: 'amount' as const, taxAmount: row[colIndex] as number }
  })
}

interface ApiTaxRow {
  'år': string
  'tabellnr': string
  'inkomst fr.o.m.': string
  'inkomst t.o.m.': string
  'kolumn 1': string
  'kolumn 2': string
  'kolumn 3': string
  'kolumn 4': string
  'kolumn 5': string
  'kolumn 6': string
}

/**
 * Fetch all rows of one table section ("30B" = monthly krona amounts,
 * "30%" = monthly percent rows) from Skatteverket's rowstore API, following
 * pagination. The API field names have Swedish characters: "år",
 * "inkomst fr.o.m.", "inkomst t.o.m.".
 */
async function fetchApiRows(
  year: number,
  tableNumber: number,
  antalDgr: '30B' | '30%'
): Promise<ApiTaxRow[]> {
  const buildParams = (offset?: number) => {
    const params = new URLSearchParams({
      'år': year.toString(),
      'tabellnr': tableNumber.toString(),
      'antal dgr': antalDgr,
      '_limit': '500',
    })
    if (offset !== undefined) params.set('_offset', offset.toString())
    return params
  }

  const response = await fetch(`${TAX_TABLE_API}?${buildParams().toString()}`, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000),
  })

  if (!response.ok) {
    throw new Error(`Skatteverket API returned ${response.status}`)
  }

  const data = await response.json() as { results: ApiTaxRow[]; resultCount: number }

  // If more than 500 results, fetch remaining pages. A silently skipped page
  // would leave a gap in the bracket list, so any page failure fails the whole
  // fetch and lets the bundled fallback serve complete data instead.
  let allResults = data.results
  if (data.resultCount > 500) {
    let offset = 500
    while (offset < data.resultCount) {
      const pageRes = await fetch(`${TAX_TABLE_API}?${buildParams(offset).toString()}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
      })
      if (!pageRes.ok) {
        throw new Error(`Skatteverket API returned ${pageRes.status} for page offset ${offset}`)
      }
      const pageData = await pageRes.json() as { results: ApiTaxRow[] }
      if (pageData.results.length === 0) {
        throw new Error(`Skatteverket API returned an empty page at offset ${offset}`)
      }
      allResults = allResults.concat(pageData.results)
      offset += 500
    }
  }

  return allResults
}

/**
 * Fetch tax table rates from Skatteverket's open data API.
 * Returns all brackets for a specific year/table/column combination.
 *
 * On API failure, falls back to bundled Skatteverket TXT data (see
 * tax-tables-fallback.ts). If neither source has the requested year,
 * throws TaxTableUnavailableError so payroll calculation fails loudly.
 *
 * Results are cached in-memory for 1 hour.
 */
export async function fetchTaxTableRates(
  year: number,
  tableNumber: number,
  column: number
): Promise<TaxTableRatesResult> {
  const cacheKey = `${year}-${tableNumber}-${column}`
  const cached = rateCache.get(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { rates: cached.rates, source: cached.source }
  }

  try {
    log.info(`Fetching tax table ${tableNumber} col ${column} for ${year} from Skatteverket API`)

    // Fetch both sections of the table: "30B" rows (fixed SEK amounts, incomes
    // up to 80 000 kr) and "30%" rows (percent of the whole income, above).
    // Loading only the B-rows would silently clamp high incomes to the last
    // krona bracket and under-withhold.
    const [amountRows, percentRows] = await Promise.all([
      fetchApiRows(year, tableNumber, '30B'),
      fetchApiRows(year, tableNumber, '30%'),
    ])

    if (amountRows.length === 0 || percentRows.length === 0) {
      // API responded but is missing a section for this year/table: treat like
      // failure so the fallback path runs below.
      throw new Error(
        `Skatteverket API returned no ${amountRows.length === 0 ? 'amount' : 'percent'} rows ` +
          `for table ${tableNumber} year ${year}`
      )
    }

    // Parse results: each row has all 6 columns, we extract the requested one.
    // Kolumn values are parsed strictly: a malformed value must not silently
    // become 0 kr / 0 % withholding, it fails the fetch so the fallback runs.
    const columnKey = `kolumn ${column}` as keyof ApiTaxRow
    const parseKolumnValue = (r: ApiTaxRow): number => {
      const raw = (r[columnKey] as string | undefined) ?? ''
      const cleaned = raw.trim().replace(',', '.')
      if (!/^\d+(\.\d+)?$/.test(cleaned)) {
        throw new Error(
          `Skatteverket API returned unparsable ${String(columnKey)} value "${raw}" ` +
            `for table ${tableNumber} year ${year} (income ${r['inkomst fr.o.m.']})`
        )
      }
      return parseFloat(cleaned)
    }
    // Income boundaries get the same strictness: a malformed boundary would
    // silently corrupt a bracket range (parseInt accepts "100abc"; || turns
    // garbage into 0 or an open-ended bracket). An empty upper bound is legal
    // only on percent rows (the open-ended top row).
    const parseIncomeBoundary = (raw: string | undefined, allowEmpty: boolean): number => {
      const cleaned = (raw ?? '').trim()
      if (cleaned === '') {
        if (allowEmpty) return 9999999
        throw new Error(
          `Skatteverket API returned an empty income boundary for table ${tableNumber} year ${year}`
        )
      }
      if (!/^\d+$/.test(cleaned)) {
        throw new Error(
          `Skatteverket API returned malformed income boundary "${raw}" for table ${tableNumber} year ${year}`
        )
      }
      return parseInt(cleaned, 10)
    }
    const parseRow = (r: ApiTaxRow, allowOpenEnd: boolean) => ({
      tableYear: year,
      tableNumber: tableNumber,
      columnNumber: column,
      incomeFrom: parseIncomeBoundary(r['inkomst fr.o.m.'], false),
      incomeTo: parseIncomeBoundary(r['inkomst t.o.m.'], allowOpenEnd),
    })
    const rates: TaxTableRate[] = [
      ...amountRows.map(r => ({
        ...parseRow(r, false),
        kind: 'amount' as const,
        taxAmount: parseKolumnValue(r),
      })),
      ...percentRows.map(r => ({
        ...parseRow(r, true),
        kind: 'percent' as const,
        taxPercent: parseKolumnValue(r),
      })),
    ]

    rateCache.set(cacheKey, { rates, source: 'api', fetchedAt: Date.now() })
    log.info(`Fetched ${rates.length} tax brackets for table ${tableNumber} col ${column} (${year})`)
    return { rates, source: 'api' }
  } catch (err) {
    const apiErr = err instanceof Error ? err.message : 'unknown'
    const fallbackRates = getFallbackRates(year, tableNumber, column)

    if (fallbackRates) {
      log.warn(
        `Skatteverket API unavailable (${apiErr}): using bundled fallback for table ${tableNumber} col ${column} (${year})`
      )
      rateCache.set(cacheKey, {
        rates: fallbackRates,
        source: 'fallback',
        fetchedAt: Date.now(),
      })
      return { rates: fallbackRates, source: 'fallback' }
    }

    const supportedYears = Array.from(FALLBACK_TAX_TABLE_YEARS).join(', ') || 'none'
    throw new TaxTableUnavailableError(
      `Kunde inte hämta skattetabell ${tableNumber} kolumn ${column} för ${year} från Skatteverket ` +
        `(${apiErr}). Ingen lokal reservdata finns för året ${year} (reservdata finns för: ${supportedYears}).`,
      { year, tableNumber, column }
    )
  }
}

/**
 * Fetch all tax table rates for a year (all tables/columns for a salary run).
 * Used by the calculate route for bulk lookups.
 *
 * Returns { rates, source } where source is 'api' if every table came from the
 * API, 'fallback' if every table came from the local fallback, and 'mixed' if
 * some came from each (indicates partial API outage).
 */
export async function fetchAllTaxTableRatesForRun(
  year: number,
  tableNumbers: number[],
  columns: number[]
): Promise<{ rates: TaxTableRate[]; source: TaxTableSource | 'mixed' }> {
  const allRates: TaxTableRate[] = []
  const uniquePairs = new Set<string>()
  let sawApi = false
  let sawFallback = false

  for (const table of tableNumbers) {
    for (const col of columns) {
      const key = `${table}-${col}`
      if (uniquePairs.has(key)) continue
      uniquePairs.add(key)

      const { rates, source } = await fetchTaxTableRates(year, table, col)
      allRates.push(...rates)
      if (source === 'api') sawApi = true
      else if (source === 'fallback') sawFallback = true
    }
  }

  const source: TaxTableSource | 'mixed' =
    sawApi && sawFallback ? 'mixed' : sawFallback ? 'fallback' : 'api'

  return { rates: allRates, source }
}

/**
 * Fetch kommun → tax table number mapping from Skatteverket's open data API.
 */
export async function fetchKommunTaxRates(year: number): Promise<Array<{
  kommun: string
  totalRate: number
  tableNumber: number
}>> {
  // The dataset has one row per församling (~1300/year), not per kommun (~290),
  // so a single page would silently drop most municipalities. Page through all
  // rows via _offset until the result set is exhausted.
  const PAGE_SIZE = 500
  const MAX_ROWS = 5000 // safety cap (~4x the real row count)

  // Deduplicate by kommun (multiple församlingar per kommun share the same
  // kommunal + landstingsskatt, so the first row's rate is representative).
  const byKommun = new Map<string, number>()
  let offset = 0

  while (offset < MAX_ROWS) {
    const params = new URLSearchParams({
      'år': year.toString(),
      '_limit': String(PAGE_SIZE),
      '_offset': String(offset),
    })

    const response = await fetch(`${KOMMUN_RATES_API}?${params.toString()}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    })

    if (!response.ok) {
      throw new Error(`Kommun rates API returned ${response.status}`)
    }

    const data = await response.json() as {
      resultCount?: number
      results: Array<{
        'kommun': string
        'summa, exkl. kyrkoavgift': string
      }>
    }

    for (const r of data.results) {
      const kommun = normalizeKommunName(r.kommun)
      const rate = parseFloat(r['summa, exkl. kyrkoavgift'])
      if (kommun && !byKommun.has(kommun)) {
        byKommun.set(kommun, rate)
      }
    }

    offset += data.results.length
    // Stop when the page came back short or we've consumed the whole dataset.
    if (data.results.length < PAGE_SIZE) break
    if (typeof data.resultCount === 'number' && offset >= data.resultCount) break
  }

  return Array.from(byKommun.entries()).map(([kommun, rate]) => {
    // Table number per Skatteverket: a fractional part of at most 50 öre picks
    // the lower table, 51 öre or more the higher (32,50 gives table 32 but
    // 32,51 gives 33). Compare in hundredths so float noise cannot decide the
    // boundary (32.51 * 100 === 3250.9999999999995 before rounding).
    const hundredths = Math.round(rate * 100)
    const tableNumber =
      hundredths % 100 <= 50 ? Math.floor(hundredths / 100) : Math.ceil(hundredths / 100)
    return { kommun, totalRate: rate, tableNumber }
  })
}

/**
 * Skatteverket returns kommun names in uppercase ("UPPLANDS VÄSBY"). Title-case
 * them for display and storage, preserving hyphenated parts ("Höör-...") and the
 * common "i"/"och" connectors lowercase.
 */
function normalizeKommunName(raw: string): string {
  const lowerWords = new Set(['i', 'och'])
  return raw
    .trim()
    .toLowerCase()
    .split(/(\s+|-)/) // keep separators (spaces, hyphens) as tokens
    .map((token) => {
      if (token.trim() === '' || token === '-') return token
      if (lowerWords.has(token)) return token
      return token.charAt(0).toUpperCase() + token.slice(1)
    })
    .join('')
}

// ── Legacy compatibility (used by calculation-engine.ts) ──

/**
 * Percentage-based skatteavdrag stated in whole kronor with öretal dropped
 * (the whole-krona rule in SFF 2011:1261 22 kap. 1 §), same rule as
 * taxForRate above. Computed in integer öre and hundredths of a percent:
 * truncating the raw float product would lose a whole krona when float noise
 * lands an exact result just below an integer
 * (1000 × 0.007 === 6.999999999999999, so 0.7 % jämkning of 1 000 kr would
 * come out as 6 kr instead of 7 kr).
 */
function wholeKronaPercentageTax(monthlyIncome: number, percentage: number): number {
  const incomeOre = Math.round(monthlyIncome * 100)
  const percentageHundredths = Math.round(percentage * 100)
  // Math.trunc, not Math.floor: dropping öre truncates toward zero, and a
  // negative taxable income (deductions exceeding pay) must not gain an extra
  // negative krona. Normalize the -0 that Math.trunc leaves on small negatives.
  const wholeKronor = Math.trunc((incomeOre * percentageHundredths) / 1_000_000)
  return wholeKronor === 0 ? 0 : wholeKronor
}

/**
 * Calculate tax using jämkning (custom percentage from Skatteverket decision).
 */
export function calculateJamkningTax(monthlyIncome: number, jamkningPercentage: number): number {
  return wholeKronaPercentageTax(monthlyIncome, jamkningPercentage)
}

/**
 * Calculate tax for sidoinkomst (flat 30%).
 */
export function calculateSidoinkomstTax(monthlyIncome: number): number {
  return wholeKronaPercentageTax(monthlyIncome, 30)
}

/**
 * Clear the in-memory tax table cache. Used in tests.
 */
export function clearTaxTableCache(): void {
  rateCache.clear()
}
