import * as XLSX from 'xlsx'

/**
 * Generic xlsx workbook builder for reports.
 *
 * The helper is intentionally declarative: callers describe one or more sheets
 * via `SheetSpec`, each with a header row and a row mapper. Column-level number
 * formatting hints (currency, date, integer, percent) are applied per-cell via
 * the `z` (number format) field on the cell object.
 *
 * Currency format follows the Swedish accounting convention used in formatCurrency
 * (`lib/utils.ts`): `#,##0.00 " kr"`. Dates use ISO `yyyy-mm-dd` to match
 * `formatDate(x)`. Both align with how figures are displayed in-app.
 *
 * Bolding the header row would require `xlsx-style` or `cellStyles: true` which
 * is not supported in the base `xlsx` distribution we ship. Instead we freeze
 * the first row so the headers stay visible while scrolling — visually distinct
 * without depending on optional packages.
 *
 * Column widths are computed automatically from the maximum content length per
 * column. This keeps the produced file legible in Excel/Numbers without any
 * post-processing by the caller.
 */

export type CellValue = string | number | Date | null | undefined
export type ColumnFormat = 'text' | 'currency' | 'date' | 'integer' | 'percent'

export interface ColumnSpec {
  /** Human-readable header label rendered in row 1. */
  header: string
  /** Excel number-format hint applied to every body cell in this column. */
  format: ColumnFormat
}

export interface SheetSpec<TRow> {
  /** Sheet tab name. Excel limits this to 31 characters; longer names are truncated. */
  name: string
  /** Column definitions (header + format), one per column. */
  columns: ColumnSpec[]
  /** Array of rows the sheet should render. */
  rows: TRow[]
  /**
   * Maps a single row to an array of cell values. The returned array length
   * must match `columns.length`. Use `null`/`undefined` for blank cells.
   */
  mapRow: (row: TRow) => CellValue[]
}

const CURRENCY_FORMAT = '#,##0.00 " kr"'
const DATE_FORMAT = 'yyyy-mm-dd'
const INTEGER_FORMAT = '#,##0'
const PERCENT_FORMAT = '0.00%'

function formatToZ(format: ColumnFormat): string | undefined {
  switch (format) {
    case 'currency':
      return CURRENCY_FORMAT
    case 'date':
      return DATE_FORMAT
    case 'integer':
      return INTEGER_FORMAT
    case 'percent':
      return PERCENT_FORMAT
    default:
      return undefined
  }
}

/**
 * Compute display length for column-width sizing. For numbers and dates we
 * approximate the formatted width (currency picks up the " kr" suffix; dates
 * are always 10 chars; integers add thousand separators). For strings we use
 * actual length. Null/undefined cells contribute 0.
 */
function displayLength(value: CellValue, format: ColumnFormat): number {
  if (value === null || value === undefined) return 0
  if (value instanceof Date) return 10 // yyyy-mm-dd
  if (typeof value === 'number') {
    switch (format) {
      case 'currency': {
        // "12 345 678,90 kr" ≈ integer-with-thousands + 6 (decimals, separator, suffix)
        const formatted = Math.abs(value)
          .toFixed(2)
          .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
        return formatted.length + 3 + (value < 0 ? 1 : 0) // +3 for " kr"
      }
      case 'integer': {
        const formatted = Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
        return formatted.length + (value < 0 ? 1 : 0)
      }
      case 'percent':
        return (value * 100).toFixed(2).length + 1
      default:
        return value.toString().length
    }
  }
  return String(value).length
}

/**
 * Build a workbook buffer from one or more sheet specs.
 *
 * @returns A Node Buffer containing the serialized xlsx file.
 */
// The generic `_T` is preserved for source-compatibility with callers that
// pass an explicit type argument (e.g. `reportToWorkbook<FlatRow>([...])`).
// Internally we accept heterogeneous sheet types via `SheetSpec<any>` because
// TypeScript cannot unify multiple sheets with different row types via a
// single type parameter. Per-sheet type safety still applies inside each
// `SheetSpec<TRow>` declaration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
export function reportToWorkbook<_T = unknown>(spec: ReadonlyArray<SheetSpec<any>>): Buffer {
  if (spec.length === 0) {
    throw new Error('reportToWorkbook: at least one sheet spec is required')
  }

  const workbook = XLSX.utils.book_new()

  for (const sheet of spec) {
    // Build AOA (array of arrays): row 0 = headers, rows 1..n = body.
    const headerRow = sheet.columns.map((c) => c.header)
    const bodyRows = sheet.rows.map((row) => {
      const mapped = sheet.mapRow(row)
      if (mapped.length !== sheet.columns.length) {
        throw new Error(
          `reportToWorkbook: row length ${mapped.length} does not match column count ${sheet.columns.length} on sheet "${sheet.name}"`,
        )
      }
      return mapped.map((v) => (v === undefined ? null : v))
    })

    const aoa: CellValue[][] = [headerRow, ...bodyRows]
    // `cellDates: true` tells xlsx to write Date values as Excel date cells
    // (type 'd', not type 'n'), so callers can use native Date objects and get
    // real date typing in the file.
    const worksheet = XLSX.utils.aoa_to_sheet(aoa as unknown[][], { cellDates: true })

    // Apply per-column number format on body cells (skip header row at r=0).
    if (bodyRows.length > 0) {
      for (let colIdx = 0; colIdx < sheet.columns.length; colIdx++) {
        const fmt = formatToZ(sheet.columns[colIdx].format)
        if (!fmt) continue
        for (let rowIdx = 1; rowIdx <= bodyRows.length; rowIdx++) {
          const ref = XLSX.utils.encode_cell({ r: rowIdx, c: colIdx })
          const cell = worksheet[ref]
          if (cell) {
            cell.z = fmt
          }
        }
      }
    }

    // Auto-size columns based on max content length per column. Header counts
    // too — a short numeric column with a long header still needs to fit the
    // label. Min 8, max 60 chars to avoid degenerate widths.
    const colWidths = sheet.columns.map((col, colIdx) => {
      let maxLen = col.header.length
      for (const row of bodyRows) {
        const cellValue = row[colIdx]
        const len = displayLength(cellValue as CellValue, col.format)
        if (len > maxLen) maxLen = len
      }
      const width = Math.min(Math.max(maxLen + 2, 8), 60)
      return { wch: width }
    })
    worksheet['!cols'] = colWidths

    // Freeze the header row so users can scroll the body without losing
    // column titles. Compensates for not being able to bold them in base xlsx.
    worksheet['!freeze'] = { xSplit: 0, ySplit: 1 }
    // Excel format: top row stays visible
    worksheet['!views'] = [{ state: 'frozen', ySplit: 1 }]

    // Truncate sheet name to Excel's 31-char limit.
    const truncatedName = sheet.name.length > 31 ? sheet.name.slice(0, 31) : sheet.name
    XLSX.utils.book_append_sheet(workbook, worksheet, truncatedName)
  }

  // `XLSX.write` with `type: 'buffer'` returns a Node Buffer.
  const out = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Column helpers — small declarative builders so route files read cleanly.
// ─────────────────────────────────────────────────────────────────────────────

export function textColumn(header: string): ColumnSpec {
  return { header, format: 'text' }
}

export function currencyColumn(header: string): ColumnSpec {
  return { header, format: 'currency' }
}

export function dateColumn(header: string): ColumnSpec {
  return { header, format: 'date' }
}

export function integerColumn(header: string): ColumnSpec {
  return { header, format: 'integer' }
}

export function percentColumn(header: string): ColumnSpec {
  return { header, format: 'percent' }
}

// ─────────────────────────────────────────────────────────────────────────────
// Filename helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Slugify a company name for use in download filenames.
 *
 * - Lowercases everything.
 * - Replaces Swedish characters (åäö) with their ASCII fallbacks.
 * - Strips anything that's not alphanumeric.
 * - Collapses runs of separators to a single dash and trims edges.
 * - Returns `'foretag'` if the input slugifies to empty (e.g. only emoji).
 */
export function slugifyCompanyName(name: string): string {
  if (!name) return 'foretag'
  const lowered = name.toLowerCase()
  const ascii = lowered
    .replace(/å/g, 'a')
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/é/g, 'e')
    .replace(/è/g, 'e')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
  const slug = ascii
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'foretag'
}

/**
 * Build a filename in the form `<reportSlug>-<companySlug>-<periodYYYYMMDD>.xlsx`.
 *
 * @param reportSlug Static report identifier (e.g. `"trial-balance"`)
 * @param companyName Raw company name (will be slugified)
 * @param period ISO date string (`YYYY-MM-DD`); date separators are stripped
 */
export function xlsxFilename(reportSlug: string, companyName: string, period: string): string {
  const companySlug = slugifyCompanyName(companyName)
  const periodCompact = (period || '').replace(/-/g, '')
  const parts = [reportSlug, companySlug, periodCompact].filter(Boolean)
  return `${parts.join('-')}.xlsx`
}
