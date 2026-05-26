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
