/**
 * Generic CSV format parser
 *
 * Fallback parser that requires the user to map columns manually.
 * Supports configurable delimiter, decimal separator, and column mapping.
 */

import type { BankFileFormat, BankFileParseResult, ParsedBankTransaction, BankFileParseIssue, GenericCSVColumnMapping } from '../types'
import { prepareContent } from '../../shared/encoding'
import { parseCSVLine } from './nordea'
import { normalizeDate } from '../date-utils'

/**
 * Normalize Unicode minus variants (U+2212 "−", U+2013 "–", U+2014 "—", U+2010 "‐")
 * to ASCII hyphen-minus so parseFloat can read them. Northmill and some other
 * banks export negatives with U+2212; parseFloat returns NaN for those.
 */
export function normalizeMinusSign(value: string): string {
  return value.replace(/[\u2212\u2013\u2014\u2010]/g, '-')
}

/**
 * Parse a generic CSV with user-provided column mapping
 */
export function parseGenericCSV(
  content: string,
  mapping: GenericCSVColumnMapping
): BankFileParseResult {
  const prepared = prepareContent(content)
  const lines = prepared.split('\n').filter((line) => line.trim() !== '')

  const transactions: ParsedBankTransaction[] = []
  const issues: BankFileParseIssue[] = []
  let skippedRows = 0

  // Skip configured number of header/metadata rows
  const startRow = mapping.skip_rows

  // Detect decimal separator mismatch by sampling amount column
  const sampleSize = Math.min(lines.length - startRow, 20)
  let commaPattern = 0
  let periodPattern = 0
  for (let s = startRow; s < startRow + sampleSize && s < lines.length; s++) {
    const sampleLine = lines[s]?.trim()
    if (!sampleLine) continue
    const sampleFields = parseCSVLine(sampleLine, mapping.delimiter).map(f => f.trim().replace(/^"|"$/g, ''))
    const amtStr = sampleFields[mapping.amount] || ''
    if (/\d,\d{1,2}$/.test(amtStr)) commaPattern++
    if (/\d\.\d{1,2}$/.test(amtStr)) periodPattern++
  }
  if (mapping.decimal_separator === ',' && periodPattern > commaPattern && periodPattern >= 3) {
    issues.push({
      row: 0,
      message: 'Decimalavgränsare verkar vara punkt (.) men komma (,) är valt. Kontrollera inställningen.',
      severity: 'warning',
    })
  } else if (mapping.decimal_separator === '.' && commaPattern > periodPattern && commaPattern >= 3) {
    issues.push({
      row: 0,
      message: 'Decimalavgränsare verkar vara komma (,) men punkt (.) är valt. Kontrollera inställningen.',
      severity: 'warning',
    })
  }

  for (let i = startRow; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    const fields = parseCSVLine(line, mapping.delimiter).map((f) =>
      f.trim().replace(/^"|"$/g, '')
    )

    // Validate required column indices are within bounds
    const maxRequired = Math.max(mapping.date, mapping.description, mapping.amount)
    if (maxRequired >= fields.length) {
      issues.push({
        row: i + 1,
        message: `Row has ${fields.length} columns but mapping requires column ${maxRequired + 1}`,
        severity: 'warning',
      })
      skippedRows++
      continue
    }

    const dateStr = fields[mapping.date]
    const description = fields[mapping.description] || 'Unknown'
    const amountStr = fields[mapping.amount]
    const referenceStr = mapping.reference !== undefined ? fields[mapping.reference] : undefined
    const counterpartyStr = mapping.counterparty !== undefined ? fields[mapping.counterparty] : undefined
    const balanceStr = mapping.balance !== undefined ? fields[mapping.balance] : undefined

    if (!dateStr || !amountStr) {
      const missing = []
      if (!dateStr) missing.push('datum')
      if (!amountStr) missing.push('belopp')
      issues.push({ row: i + 1, message: `Saknar ${missing.join(' och ')}`, severity: 'warning' })
      skippedRows++
      continue
    }

    // Parse amount based on configured decimal separator.
    // Normalize Unicode minus first — some banks (e.g. Northmill) use U+2212
    // instead of ASCII hyphen, which parseFloat treats as NaN.
    const normalizedAmount = normalizeMinusSign(amountStr)
    let amount: number
    if (mapping.decimal_separator === ',') {
      amount = parseFloat(normalizedAmount.replace(/\s/g, '').replace(',', '.'))
    } else {
      amount = parseFloat(normalizedAmount.replace(/\s/g, ''))
    }

    if (isNaN(amount)) {
      issues.push({ row: i + 1, message: `Invalid amount: ${amountStr}`, severity: 'warning' })
      skippedRows++
      continue
    }

    // Normalize date from multiple formats to YYYY-MM-DD
    const date = normalizeDate(dateStr, mapping.date_format)
    if (!date) {
      issues.push({ row: i + 1, message: `Ogiltigt datumformat: ${dateStr.trim()}`, severity: 'warning' })
      skippedRows++
      continue
    }

    let balance: number | null = null
    if (balanceStr) {
      const normalizedBalance = normalizeMinusSign(balanceStr)
      if (mapping.decimal_separator === ',') {
        balance = parseFloat(normalizedBalance.replace(/\s/g, '').replace(',', '.'))
      } else {
        balance = parseFloat(normalizedBalance.replace(/\s/g, ''))
      }
      if (isNaN(balance)) balance = null
    }

    transactions.push({
      date,
      description: description.trim(),
      amount,
      currency: 'SEK',
      balance,
      reference: referenceStr?.trim() || null,
      counterparty: counterpartyStr?.trim() || null,
      raw_line: line,
    })
  }

  const dates = transactions.map((t) => t.date).sort()

  return {
    format: 'generic_csv',
    format_name: 'CSV (manuell mappning)',
    transactions,
    date_from: dates[0] || null,
    date_to: dates[dates.length - 1] || null,
    issues,
    stats: {
      total_rows: lines.length - startRow,
      parsed_rows: transactions.length,
      skipped_rows: skippedRows,
      total_income: Math.round(transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0) * 100) / 100,
      total_expenses: Math.round(transactions.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0) * 100) / 100,
    },
  }
}

/**
 * Get column headers from a CSV file for the mapping UI
 */
export function getCSVHeaders(content: string, delimiter: string = ','): string[] {
  const prepared = prepareContent(content)
  const firstLine = prepared.split('\n')[0] || ''
  return parseCSVLine(firstLine, delimiter).map((h) => h.trim().replace(/^"|"$/g, ''))
}

/**
 * Get a preview of the first few rows of a CSV file
 */
export function getCSVPreview(content: string, delimiter: string = ',', rows: number = 5): string[][] {
  const prepared = prepareContent(content)
  const lines = prepared.split('\n').filter((line) => line.trim() !== '')

  return lines.slice(0, rows).map((line) =>
    parseCSVLine(line, delimiter).map((f) => f.trim().replace(/^"|"$/g, ''))
  )
}

/** Column indices suggested for the manual mapping UI. -1 = not resolved. */
export interface SuggestedColumnMapping {
  date: number
  description: number
  amount: number
  balance: number
}

// A cell that looks like a date in one of the formats the importer accepts.
const SUGGEST_DATE_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}$/,
  /^\d{2}[./]\d{2}[./]\d{4}$/,
  /^\d{4}\/\d{2}\/\d{2}$/,
  /^\d{8}$/,
]

/** Pick the best date column by header label, preferring transaction date over value date. */
function pickDateHeader(headers: string[]): number {
  const tiers: Array<(h: string) => boolean> = [
    (h) => h.includes('transaktionsdatum'),
    (h) => h.includes('reskontradatum'),
    (h) => /bokf(ö|o)ringsda(g|tum)/.test(h),
    (h) => h === 'datum' || h === 'date',
  ]
  for (const match of tiers) {
    const idx = headers.findIndex((h) => match(h) && !h.includes('valuta'))
    if (idx >= 0) return idx
  }
  return headers.findIndex((h) => (h.includes('datum') || h.includes('date')) && !h.includes('valuta'))
}

/** Pick the best description column by header label. */
function pickDescriptionHeader(headers: string[]): number {
  const keywords = ['text', 'beskrivning', 'description', 'rubrik', 'meddelande', 'referens', 'mottagare', 'namn']
  for (const kw of keywords) {
    const idx = headers.findIndex((h) => h === kw || h.includes(kw))
    if (idx >= 0) return idx
  }
  return -1
}

/** Per-column value statistics across the sampled data rows. */
function analyzeColumns(dataRows: string[][], colCount: number) {
  const acc = Array.from({ length: colCount }, () => ({ numeric: 0, date: 0, negative: 0, nonEmpty: 0 }))
  for (const row of dataRows.slice(0, 20)) {
    for (let i = 0; i < colCount; i++) {
      const raw = (row[i] ?? '').trim()
      if (!raw) continue
      acc[i].nonEmpty++
      if (SUGGEST_DATE_PATTERNS.some((re) => re.test(raw))) acc[i].date++
      const cleaned = normalizeMinusSign(raw).replace(/\s/g, '')
      if (/^-?\d+([.,]\d+)?$/.test(cleaned)) {
        acc[i].numeric++
        if (cleaned.startsWith('-')) acc[i].negative++
      }
    }
  }
  return acc.map((s) => ({
    isDate: s.nonEmpty > 0 && s.date / s.nonEmpty >= 0.5,
    isNumeric: s.nonEmpty > 0 && s.numeric / s.nonEmpty >= 0.5,
    hasNegative: s.negative > 0,
  }))
}

/**
 * Suggest date / description / amount / balance column indices for the manual
 * CSV mapping UI.
 *
 * When a header row is available, columns are matched by their label first
 * (belopp → amount, saldo → balance, …) so a trailing running-balance column is
 * never mistaken for the amount — the original positional heuristic walked the
 * row right-to-left and grabbed Saldo as the amount on the common
 * `…;Belopp;Saldo` layout. Falls back to value-based heuristics on the sample
 * data for any column the labels don't resolve; there the amount guess
 * explicitly skips the balance column and prefers a column carrying negative
 * values (real transaction amounts swing negative, a running balance usually
 * does not).
 *
 * @param headers Header labels, or null when the file has no header row.
 * @param dataRows Sample data rows already split into cells.
 */
export function suggestColumnMapping(
  headers: string[] | null,
  dataRows: string[][]
): SuggestedColumnMapping {
  const result: SuggestedColumnMapping = { date: -1, description: -1, amount: -1, balance: -1 }

  const colCount = Math.max(
    headers?.length ?? 0,
    ...dataRows.slice(0, 10).map((r) => r.length),
    0
  )
  if (colCount === 0) return result

  // 1. Label-based matching when we have a header row.
  if (headers) {
    const hdr = headers.map((h) => h.trim().toLowerCase().replace(/"/g, ''))
    result.date = pickDateHeader(hdr)
    result.balance = hdr.findIndex((h) => h.includes('saldo') || h.includes('balance'))
    result.amount = hdr.findIndex(
      (h, i) => i !== result.balance && (h === 'belopp' || h.includes('belopp') || h.includes('amount'))
    )
    result.description = pickDescriptionHeader(hdr)
  }

  // 2. Value-based fallback for anything the labels didn't resolve.
  const stats = analyzeColumns(dataRows, colCount)

  if (result.date === -1) {
    result.date = stats.findIndex((s) => s.isDate)
  }

  if (result.amount === -1 || result.balance === -1) {
    const numericCols = stats
      .map((s, i) => ({ i, s }))
      .filter(({ i, s }) => i !== result.date && s.isNumeric)

    if (result.amount === -1) {
      const candidates = numericCols.filter(({ i }) => i !== result.balance)
      const negative = candidates.find(({ s }) => s.hasNegative)
      result.amount = (negative ?? candidates[0])?.i ?? -1
    }

    if (result.balance === -1) {
      // Remaining numeric column (typically the trailing running balance).
      const remaining = numericCols.filter(({ i }) => i !== result.amount)
      result.balance = remaining.length ? remaining[remaining.length - 1].i : -1
    }
  }

  if (result.description === -1) {
    result.description = stats.findIndex(
      (s, i) => i !== result.date && i !== result.amount && i !== result.balance && !s.isNumeric && !s.isDate
    )
    if (result.description === -1) {
      for (let i = 0; i < colCount; i++) {
        if (i !== result.date && i !== result.amount && i !== result.balance) {
          result.description = i
          break
        }
      }
    }
  }

  return result
}

/**
 * Generic CSV format definition (used for format detection)
 * Always returns false for detect() since it's a fallback requiring user mapping
 */
export const genericCSVFormat: BankFileFormat = {
  id: 'generic_csv',
  name: 'CSV (manuell mappning)',
  description: 'Generisk CSV-fil med manuell kolumnmappning',
  fileExtensions: ['.csv', '.txt'],

  detect(_content: string, _filename: string): boolean {
    // Generic CSV never auto-detects — it's the manual fallback
    return false
  },

  parse(content: string): BankFileParseResult {
    // Default mapping for a basic CSV: date, description, amount
    const defaultMapping: GenericCSVColumnMapping = {
      date: 0,
      description: 1,
      amount: 2,
      delimiter: ',',
      decimal_separator: ',',
      skip_rows: 1,
      date_format: 'YYYY-MM-DD',
    }
    return parseGenericCSV(content, defaultMapping)
  },
}
