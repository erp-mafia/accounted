import type { ArticleType } from '@/types'
import { detectArticleColumns } from './column-detector'
import { cellOrNull } from '../shared/column-utils'
import { parseAmount } from '../opening-balance/parser'
import { readBestSheet } from '../shared/workbook-reader'
import type { DetectedArticleColumns, ParsedArticleRow } from './types'

const VALID_VAT_RATES = [0, 6, 12, 25] as const

/** Snap an arbitrary VAT percentage to the nearest Swedish statutory rate. */
function snapVatRate(n: number): number {
  let best: number = VALID_VAT_RATES[0]
  let bestDist = Math.abs(n - best)
  for (const r of VALID_VAT_RATES) {
    const d = Math.abs(n - r)
    if (d < bestDist) {
      best = r
      bestDist = d
    }
  }
  return best
}

/**
 * Normalize a VAT cell to one of {0,6,12,25}. Handles "25%", "25", "0,25"
 * (fraction), and Swedish decimal commas. Returns the snapped rate plus an
 * optional human note when the raw value was non-empty but not already valid
 * (e.g. a Fortnox `momskod` letter code or an unsupported percentage).
 */
function normalizeVatRate(raw: string | null): { rate: number; note: string | null } {
  if (!raw) return { rate: 25, note: null }
  const cleaned = raw
    .replace(/%/g, '')
    .replace(/\s/g, '')
    .replace(/\.(?=\d{3})/g, '') // dot thousand-separator
    .replace(',', '.') // Swedish decimal comma
    .trim()
  let n = parseFloat(cleaned)
  // Unparseable (e.g. a Fortnox `momskod` like "MP1") → default with a note.
  if (Number.isNaN(n)) {
    return { rate: 25, note: `Kunde inte tolka momssats "${raw}": satt till 25 %` }
  }
  // Fraction form (0.25 → 25).
  if (n > 0 && n < 1) n = n * 100
  const snapped = snapVatRate(n)
  const wasValid = (VALID_VAT_RATES as readonly number[]).includes(Math.round(n))
  return {
    rate: snapped,
    note: wasValid ? null : `Momssats ${raw} avrundades till ${snapped} %`,
  }
}

function normalizeArticleType(value: string | null): ArticleType {
  if (!value) return 'tjanst'
  const lower = value.toLowerCase().trim()
  if (
    lower === 'vara' || lower === 'varor' || lower === 'produkt' ||
    lower === 'product' || lower === 'goods' || lower === 'artikel' ||
    lower === 'lagervara' || lower === 'stock'
  ) {
    return 'vara'
  }
  // Everything else (tjänst/service/…) maps to the DB default.
  return 'tjanst'
}

const INCL_VAT_HEADER_RE = /brutto|inkl|incl|gross/i

/**
 * Parse an article-register file (Excel or CSV) into structured rows.
 *
 * Prices are read as EXCLUDING VAT (what the `articles` table stores). When the
 * matched price header looks like an incl-VAT column a file-level warning is
 * emitted rather than silently converting (the rate isn't reliably known here).
 *
 * @param buffer - Raw file buffer
 * @param filename - Original filename
 * @param columnOverrides - Optional manual column mapping
 */
export function parseArticlesFile(
  buffer: ArrayBuffer,
  filename: string,
  columnOverrides?: DetectedArticleColumns,
): {
  filename: string
  sheet_name: string
  total_rows: number
  detected_columns: DetectedArticleColumns
  headers: string[]
  preview_rows: string[][]
  rows: ParsedArticleRow[]
  warnings: string[]
} {
  const { sheetName, rawData } = readBestSheet(buffer, filename)

  if (rawData.length < 2) {
    const fallbackColumns: DetectedArticleColumns = columnOverrides ?? {
      name_col: 0,
      article_number_col: null,
      name_en_col: null,
      type_col: null,
      unit_col: null,
      price_col: null,
      vat_rate_col: null,
      revenue_account_col: null,
      cost_price_col: null,
      ean_col: null,
      housework_type_col: null,
      notes_col: null,
      confidence: 0,
    }
    return {
      filename,
      sheet_name: sheetName,
      total_rows: 0,
      detected_columns: fallbackColumns,
      headers: rawData[0]?.map((h) => String(h)) || [],
      preview_rows: [],
      rows: [],
      warnings: ['Filen innehåller för få rader.'],
    }
  }

  const headers = rawData[0].map((h) => String(h))
  const dataRows = rawData.slice(1)
  const columns = columnOverrides || detectArticleColumns(headers)

  const rows: ParsedArticleRow[] = []
  const warnings: string[] = []
  const cell = (row: string[], col: number | null): string | null =>
    col !== null ? cellOrNull(row[col]) : null

  // Surface incl-VAT price columns once for the whole file.
  if (columns.price_col !== null && INCL_VAT_HEADER_RE.test(headers[columns.price_col] ?? '')) {
    warnings.push(
      `Priskolumnen "${headers[columns.price_col]}" verkar vara inkl. moms: priser importeras som exkl. moms. Kontrollera värdena.`,
    )
  }

  let vatNoteCount = 0
  let droppedAccountCount = 0

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]
    const name = cell(row, columns.name_col)
    if (!name) continue // skip empty rows silently

    const articleNumber = cell(row, columns.article_number_col)
    const nameEn = cell(row, columns.name_en_col)
    const type = normalizeArticleType(cell(row, columns.type_col))
    const unitRaw = cell(row, columns.unit_col)
    const unit = unitRaw ?? 'st'

    const priceRaw = cell(row, columns.price_col)
    const price = priceRaw !== null ? parseAmount(priceRaw) : 0

    const { rate: vatRate, note: vatNote } = normalizeVatRate(cell(row, columns.vat_rate_col))
    if (vatNote) vatNoteCount++

    // Keep only well-formed BAS class-3 overrides; the execute route validates
    // them further against the chart of accounts.
    const revenueRaw = cell(row, columns.revenue_account_col)
    let revenueAccount: string | null = null
    if (revenueRaw) {
      const digits = revenueRaw.replace(/\s/g, '')
      if (/^3\d{3}$/.test(digits)) revenueAccount = digits
      else droppedAccountCount++
    }

    const costRaw = cell(row, columns.cost_price_col)
    const costPrice = costRaw !== null ? parseAmount(costRaw) : null

    const ean = cell(row, columns.ean_col)
    const houseworkType = cell(row, columns.housework_type_col)
    const notes = cell(row, columns.notes_col)

    const validationErrors: string[] = []
    if (price < 0) validationErrors.push('Priset kan inte vara negativt')
    if (costPrice !== null && costPrice < 0) validationErrors.push('Inköpspriset kan inte vara negativt')

    rows.push({
      row_index: i + 2, // 1-based + header
      name,
      name_en: nameEn,
      article_number: articleNumber,
      type,
      unit,
      price_excl_vat: price,
      vat_rate: vatRate,
      // A note means the rate was snapped or defaulted: flag it for review.
      vat_rate_adjusted: vatNote !== null,
      revenue_account: revenueAccount,
      cost_price: costPrice,
      ean,
      housework_type: houseworkType,
      notes,
      is_valid: validationErrors.length === 0,
      validation_errors: validationErrors,
    })
  }

  if (vatNoteCount > 0) {
    warnings.push(`${vatNoteCount} rad${vatNoteCount === 1 ? '' : 'er'} hade en momssats som avrundades till närmaste giltiga (0/6/12/25 %).`)
  }
  if (droppedAccountCount > 0) {
    warnings.push(`${droppedAccountCount} rad${droppedAccountCount === 1 ? '' : 'er'} hade ett ogiltigt försäljningskonto (måste vara 3xxx) som ignorerades.`)
  }
  if (rows.length === 0) {
    warnings.push('Inga giltiga artiklar hittades. Kontrollera att namn-/benämningskolumnen är korrekt mappad.')
  }

  return {
    filename,
    sheet_name: sheetName,
    total_rows: rows.length,
    detected_columns: columns,
    headers,
    preview_rows: dataRows.slice(0, 5),
    rows,
    warnings,
  }
}
