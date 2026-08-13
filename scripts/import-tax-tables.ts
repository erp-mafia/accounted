/**
 * Parse Skatteverket SKV 434 monthly tax tables (fixed-width TXT) and emit a
 * TypeScript module used as an emergency fallback when Skatteverket's open-data
 * API is unavailable.
 *
 * Input:  data/tax-tables/{year}/allmanna-tabeller-manad.txt
 * Output: lib/salary/tax-tables-fallback.ts
 *
 * Record format (49 chars per line):
 *   chars 0-4   (width 5): prefix : "30B29" = monthly/belopp, table 29;
 *                          "30%29" = monthly/percent, table 29
 *   chars 5-11  (width 7): income_from
 *   chars 12-18 (width 7): income_to (blank on the open-ended top %-row)
 *   chars 19-23 (width 5): column 1 (SEK on B-rows, percent on %-rows)
 *   chars 24-28 (width 5): column 2
 *   chars 29-33 (width 5): column 3
 *   chars 34-38 (width 5): column 4
 *   chars 39-43 (width 5): column 5
 *   chars 44-48 (width 5): column 6
 *
 * Both B-rows (absolute amounts, incomes up to 80 000 kr/month) and %-rows
 * (percent of the whole income, above 80 000 kr/month) are imported. The
 * emitted tuple carries an isPercent flag as its last element.
 *
 * Usage:
 *   npx tsx scripts/import-tax-tables.ts --year 2026
 */

import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

type TaxRow = readonly [number, number, number, number, number, number, number, number, number]

interface ParsedTable {
  tableNumber: number
  rows: TaxRow[]
}

function parseArgs(): { year: number } {
  const args = process.argv.slice(2)
  const yearIdx = args.indexOf('--year')
  if (yearIdx === -1 || !args[yearIdx + 1]) {
    throw new Error('Missing --year argument')
  }
  const year = parseInt(args[yearIdx + 1], 10)
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error(`Invalid year: ${args[yearIdx + 1]}`)
  }
  return { year }
}

export function parseLine(line: string): { table: number; row: TaxRow } | null {
  // Strip BOM if present on the first line
  const clean = line.replace(/^\uFEFF/, '')
  if (clean.length < 49) return null

  const prefix = clean.slice(0, 5)
  // B-rows carry absolute SEK amounts, %-rows carry percentages for incomes
  // above the highest B-row bracket. Both are needed for correct withholding.
  if (prefix[2] !== 'B' && prefix[2] !== '%') return null
  // The day-count prefix must be "30" (monthly). Skatteverket also publishes
  // two-week tables whose rows differ only in this prefix ("14B29" vs "30B29"):
  // a two-week row must fail the import loudly, never merge silently into the
  // monthly fallback data.
  const dayCount = prefix.slice(0, 2)
  if (dayCount === '14') {
    throw new Error(
      `Two-week table row (prefix "${prefix}") in monthly import: wrong source file? Line: ${clean}`
    )
  }
  if (dayCount !== '30') return null
  const isPercent = prefix[2] === '%'

  const tableStr = prefix.slice(3, 5)
  const table = parseInt(tableStr, 10)
  if (!Number.isInteger(table)) return null

  // Column values must be well-formed whole numbers. A malformed value falling
  // back to 0 would bake 0 kr / 0 % withholding into the emitted fallback data,
  // so fail the import instead.
  const parseColumn = (start: number): number => {
    const raw = clean.slice(start, start + 5).trim()
    if (!/^\d+$/.test(raw)) {
      throw new Error(`Malformed column value "${raw}" in line: ${clean}`)
    }
    return parseInt(raw, 10)
  }

  // Income boundaries get the same digits-only rule: parseInt would accept
  // "100abc" and turn other garbage into 0, silently corrupting bracket
  // ranges. A blank income_to is legal only on the open-ended top %-row
  // (emitted as 0, mapped to the open-ended sentinel by the loader).
  const parseIncome = (start: number, allowBlank: boolean): number => {
    const raw = clean.slice(start, start + 7).trim()
    if (raw === '') {
      if (!allowBlank) throw new Error(`Missing income boundary in line: ${clean}`)
      return 0
    }
    if (!/^\d+$/.test(raw)) {
      throw new Error(`Malformed income boundary "${raw}" in line: ${clean}`)
    }
    return parseInt(raw, 10)
  }

  const incomeFrom = parseIncome(5, false)
  const incomeTo = parseIncome(12, isPercent)
  const c1 = parseColumn(19)
  const c2 = parseColumn(24)
  const c3 = parseColumn(29)
  const c4 = parseColumn(34)
  const c5 = parseColumn(39)
  const c6 = parseColumn(44)

  return {
    table,
    row: [incomeFrom, incomeTo, c1, c2, c3, c4, c5, c6, isPercent ? 1 : 0] as const,
  }
}

function parseFile(path: string): ParsedTable[] {
  const content = readFileSync(path, 'utf-8')
  const byTable = new Map<number, TaxRow[]>()

  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine.trim()) continue
    const parsed = parseLine(rawLine)
    if (!parsed) continue
    const existing = byTable.get(parsed.table)
    if (existing) {
      existing.push(parsed.row)
    } else {
      byTable.set(parsed.table, [parsed.row])
    }
  }

  const tables = Array.from(byTable.entries())
    .map(([tableNumber, rows]) => ({
      tableNumber,
      rows: rows.sort((a, b) => a[0] - b[0]),
    }))
    .sort((a, b) => a.tableNumber - b.tableNumber)

  return tables
}

function formatRow(row: TaxRow): string {
  return `[${row.join(', ')}]`
}

function emitModule(year: number, tables: ParsedTable[]): string {
  const totalRows = tables.reduce((sum, t) => sum + t.rows.length, 0)
  const tableNumbers = tables.map(t => t.tableNumber).join(', ')

  const entries = tables
    .map(t => {
      const rows = t.rows.map(formatRow).join(',\n    ')
      return `  ${t.tableNumber}: [\n    ${rows},\n  ]`
    })
    .join(',\n')

  return `/**
 * AUTO-GENERATED: do not edit by hand.
 *
 * Source: data/tax-tables/${year}/allmanna-tabeller-manad.txt (Skatteverket SKV 434)
 * Generator: scripts/import-tax-tables.ts
 *
 * Emergency fallback for lib/salary/tax-tables.ts when the Skatteverket
 * open-data API is unreachable. Do not use as the primary source: the API
 * is authoritative.
 *
 * Rows: ${totalRows} across tables ${tableNumbers}
 */

/**
 * [incomeFrom, incomeTo, col1, col2, col3, col4, col5, col6, isPercent]
 *
 * isPercent 0: columns are SEK amounts (incomes up to 80 000 kr/month).
 * isPercent 1: columns are percent of the whole monthly income (above
 * 80 000 kr/month). incomeTo 0 marks the open-ended top row.
 */
export type FallbackTaxRow = readonly [
  number, number, number, number, number, number, number, number, number,
]

/** Tables keyed by municipal tax rate number (29-42). */
export type FallbackTaxYear = Readonly<Record<number, readonly FallbackTaxRow[]>>

export const FALLBACK_TAX_TABLES_${year}: FallbackTaxYear = {
${entries},
}

export const FALLBACK_TAX_TABLES: Readonly<Record<number, FallbackTaxYear>> = {
  ${year}: FALLBACK_TAX_TABLES_${year},
}

export const FALLBACK_TAX_TABLE_YEARS: ReadonlySet<number> = new Set([${year}])
`
}

function main() {
  const { year } = parseArgs()
  const inputPath = resolve(process.cwd(), `data/tax-tables/${year}/allmanna-tabeller-manad.txt`)
  const outputPath = resolve(process.cwd(), 'lib/salary/tax-tables-fallback.ts')

  console.log(`Reading ${inputPath}`)
  const tables = parseFile(inputPath)

  if (tables.length === 0) {
    throw new Error('No rows parsed: check input file format')
  }

  // Every table must have both sections: a B-only table would clamp high
  // incomes to the last krona bracket and silently under-withhold.
  for (const t of tables) {
    const percentRows = t.rows.filter(r => r[8] === 1).length
    if (percentRows === 0 || percentRows === t.rows.length) {
      throw new Error(`Table ${t.tableNumber}: expected both B-rows and %-rows, got ${percentRows}/${t.rows.length} percent rows`)
    }
  }

  const totalRows = tables.reduce((sum, t) => sum + t.rows.length, 0)
  const percentTotal = tables.reduce((sum, t) => sum + t.rows.filter(r => r[8] === 1).length, 0)
  console.log(`Parsed ${tables.length} tables (${tables.map(t => t.tableNumber).join(', ')}), ${totalRows} rows total (${percentTotal} percent rows)`)

  const moduleSource = emitModule(year, tables)
  writeFileSync(outputPath, moduleSource, 'utf-8')
  console.log(`Wrote ${outputPath} (${moduleSource.length.toLocaleString()} bytes)`)
}

// Run only when executed directly (npx tsx scripts/import-tax-tables.ts), not
// when parseLine is imported by tests. Same pattern as generate-crontabs.ts.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
}
