/**
 * Parse Skatteverket SKV 434 monthly tax tables (fixed-width TXT) and emit a
 * TypeScript module used as an emergency fallback when Skatteverket's open-data
 * API is unavailable.
 *
 * Input:  data/tax-tables/{year}/allmanna-tabeller-manad.txt
 * Output: lib/salary/tax-tables-fallback.ts
 *
 * Record format (49 chars per line):
 *   chars 0-4   (width 5): prefix : "30B29" = monthly/belopp, table 29
 *   chars 5-11  (width 7): income_from
 *   chars 12-18 (width 7): income_to
 *   chars 19-23 (width 5): column 1 tax amount (SEK)
 *   chars 24-28 (width 5): column 2
 *   chars 29-33 (width 5): column 3
 *   chars 34-38 (width 5): column 4
 *   chars 39-43 (width 5): column 5
 *   chars 44-48 (width 5): column 6
 *
 * We import only B-rows (absolute amounts). %-rows (percentage-based, used for
 * incomes above the highest B-row bracket) are skipped: matches the behavior
 * of the Skatteverket API path which also fetches only B-rows.
 *
 * Usage:
 *   npx tsx scripts/import-tax-tables.ts --year 2026
 */

import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

type TaxRow = readonly [number, number, number, number, number, number, number, number]

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

function parseLine(line: string): { table: number; row: TaxRow } | null {
  // Strip BOM if present on the first line
  const clean = line.replace(/^\uFEFF/, '')
  if (clean.length < 49) return null

  const prefix = clean.slice(0, 5)
  // B-rows only (absolute amounts). Skip %-rows.
  if (prefix[2] !== 'B') return null

  const tableStr = prefix.slice(3, 5)
  const table = parseInt(tableStr, 10)
  if (!Number.isInteger(table)) return null

  const parseField = (start: number, width: number): number => {
    const raw = clean.slice(start, start + width).trim()
    if (raw === '') return 0
    const n = parseInt(raw, 10)
    return Number.isFinite(n) ? n : 0
  }

  const incomeFrom = parseField(5, 7)
  const incomeTo = parseField(12, 7)
  const c1 = parseField(19, 5)
  const c2 = parseField(24, 5)
  const c3 = parseField(29, 5)
  const c4 = parseField(34, 5)
  const c5 = parseField(39, 5)
  const c6 = parseField(44, 5)

  return {
    table,
    row: [incomeFrom, incomeTo, c1, c2, c3, c4, c5, c6] as const,
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

/** [incomeFrom, incomeTo, col1, col2, col3, col4, col5, col6] */
export type FallbackTaxRow = readonly [
  number, number, number, number, number, number, number, number,
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
    throw new Error('No B-rows parsed: check input file format')
  }

  const totalRows = tables.reduce((sum, t) => sum + t.rows.length, 0)
  console.log(`Parsed ${tables.length} tables (${tables.map(t => t.tableNumber).join(', ')}), ${totalRows} B-rows total`)

  const module = emitModule(year, tables)
  writeFileSync(outputPath, module, 'utf-8')
  console.log(`Wrote ${outputPath} (${module.length.toLocaleString()} bytes)`)
}

main()
