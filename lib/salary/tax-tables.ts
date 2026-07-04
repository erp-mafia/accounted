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

export interface TaxTableRate {
  tableYear: number
  tableNumber: number
  columnNumber: number
  incomeFrom: number
  incomeTo: number
  taxAmount: number
}

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
      return rate.taxAmount
    }
  }

  // Above all brackets: use last bracket (matches Skatteverket's published behavior
  // where the top B-row applies until %-rows take over; we only load B-rows)
  const lastRate = matchingRates[matchingRates.length - 1]
  if (roundedIncome > lastRate.incomeTo) {
    return lastRate.taxAmount
  }

  return 0
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

  // Columns 1-6 map to tuple indices 2-7 ([incomeFrom, incomeTo, col1..col6])
  const colIndex = column + 1
  return rows.map(row => ({
    tableYear: year,
    tableNumber,
    columnNumber: column,
    incomeFrom: row[0],
    incomeTo: row[1] || 9999999,
    taxAmount: row[colIndex] as number,
  }))
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
    // Fetch all B-rows (absolute amounts) for this table/year
    // The API field names have Swedish characters: "år", "inkomst fr.o.m.", "inkomst t.o.m."
    const params = new URLSearchParams({
      'år': year.toString(),
      'tabellnr': tableNumber.toString(),
      'antal dgr': '30B', // Monthly table, absolute amounts
      '_limit': '500',
    })

    const url = `${TAX_TABLE_API}?${params.toString()}`
    log.info(`Fetching tax table ${tableNumber} col ${column} for ${year} from Skatteverket API`)

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    })

    if (!response.ok) {
      throw new Error(`Skatteverket API returned ${response.status}`)
    }

    const data = await response.json() as {
      results: Array<{
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
      }>
      resultCount: number
    }

    // If more than 500 results, fetch remaining pages
    let allResults = data.results
    if (data.resultCount > 500) {
      let offset = 500
      while (offset < data.resultCount) {
        const pageParams = new URLSearchParams({
          'år': year.toString(),
          'tabellnr': tableNumber.toString(),
          'antal dgr': '30B',
          '_limit': '500',
          '_offset': offset.toString(),
        })
        const pageRes = await fetch(`${TAX_TABLE_API}?${pageParams.toString()}`, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(10000),
        })
        if (pageRes.ok) {
          const pageData = await pageRes.json() as { results: typeof data.results }
          allResults = allResults.concat(pageData.results)
        }
        offset += 500
      }
    }

    if (allResults.length === 0) {
      // API responded but has no rows for this year/table: treat like failure
      // so the fallback path runs below.
      throw new Error(`Skatteverket API returned no rows for table ${tableNumber} year ${year}`)
    }

    // Parse results: each row has all 6 columns, we extract the requested one
    const columnKey = `kolumn ${column}` as keyof typeof allResults[0]
    const rates: TaxTableRate[] = allResults.map(r => ({
      tableYear: year,
      tableNumber: tableNumber,
      columnNumber: column,
      incomeFrom: parseInt(r['inkomst fr.o.m.']) || 0,
      incomeTo: parseInt(r['inkomst t.o.m.']) || 9999999,
      taxAmount: parseInt(r[columnKey] as string) || 0,
    }))

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

  return Array.from(byKommun.entries()).map(([kommun, rate]) => ({
    kommun,
    totalRate: rate,
    // Table number: round total rate. ≤0.50 rounds down, ≥0.51 rounds up
    tableNumber: Math.round(rate),
  }))
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
 * Calculate tax using jämkning (custom percentage from Skatteverket decision).
 */
export function calculateJamkningTax(monthlyIncome: number, jamkningPercentage: number): number {
  return Math.round(monthlyIncome * (jamkningPercentage / 100) * 100) / 100
}

/**
 * Calculate tax for sidoinkomst (flat 30%).
 */
export function calculateSidoinkomstTax(monthlyIncome: number): number {
  return Math.round(monthlyIncome * 0.30 * 100) / 100
}

/**
 * Clear the in-memory tax table cache. Used in tests.
 */
export function clearTaxTableCache(): void {
  rateCache.clear()
}
