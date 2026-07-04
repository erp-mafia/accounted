/**
 * Länsförsäkringar CSV format parser
 *
 * Format: Semicolon-delimited, comma decimal separator, double-quoted fields
 * Columns: Datum, Bokföringsdag, Typ, Text, Belopp, (Saldo optional)
 * Date format: YYYY-MM-DD
 * Encoding: UTF-8 or Windows-1252
 *
 * Notes:
 * - Fields are double-quoted
 * - Two adjacent date columns (Datum + Bokföringsdag) is unique to Länsförsäkringar
 * - No guaranteed header row: detect by structure
 */

import type { BankFileFormat, BankFileParseResult, ParsedBankTransaction, BankFileParseIssue } from '../types'
import { prepareContent } from '../../shared/encoding'
import { normalizeDate } from '../date-utils'
import { parseCSVLine } from './nordea'

function parseCommaDecimal(value: string): number {
  const cleaned = value.replace(/\s/g, '').replace(',', '.')
  return parseFloat(cleaned)
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Check if a line has the Länsförsäkringar structure:
 * two adjacent YYYY-MM-DD date fields in a semicolon-delimited, quoted row.
 */
// Matches Swedish-format numbers like "-1 234,56", "1234,50", "-500,00"
const COMMA_NUMBER_RE = /^-?[\d\s]+,\d{1,2}$/

function isLFRow(line: string): boolean {
  if (!line.includes(';')) return false
  const fields = parseCSVLine(line, ';').map((f) => f.trim().replace(/^"|"$/g, ''))
  return (
    fields.length >= 5 &&
    DATE_RE.test(fields[0]) &&
    DATE_RE.test(fields[1]) &&
    COMMA_NUMBER_RE.test(fields[4].trim())
  )
}

/**
 * Check if a line looks like a Länsförsäkringar header row.
 */
function isLFHeader(line: string): boolean {
  const lower = line.toLowerCase().replace(/"/g, '')
  return (
    lower.includes(';') &&
    lower.includes('datum') &&
    lower.includes('typ') &&
    lower.includes('belopp')
  )
}

export const lansforsakringarFormat: BankFileFormat = {
  id: 'lansforsakringar',
  name: 'Länsförsäkringar',
  description: 'Länsförsäkringar CSV (semicolon-delimited, quoted fields)',
  fileExtensions: ['.csv', '.txt'],

  detect(content: string, _filename: string): boolean {
    const prepared = prepareContent(content)
    const lines = prepared.split('\n').filter((l) => l.trim() !== '')
    if (lines.length < 1) return false

    // Check for header with "typ" keyword (unique to LF among semicolon formats)
    if (isLFHeader(lines[0])) return true

    // Alternatively: detect data rows with two adjacent date fields
    // Check first few non-empty lines for the two-date pattern
    for (let i = 0; i < Math.min(lines.length, 3); i++) {
      if (isLFRow(lines[i])) return true
    }

    return false
  },

  parse(content: string): BankFileParseResult {
    const prepared = prepareContent(content)
    const lines = prepared.split('\n').filter((line) => line.trim() !== '')

    const transactions: ParsedBankTransaction[] = []
    const issues: BankFileParseIssue[] = []
    let skippedRows = 0

    // Determine if first row is a header or data
    let startIdx = 0
    let dateIdx = 0
    let descIdx = 3
    let amountIdx = 4
    let balanceIdx = 5

    if (isLFHeader(lines[0])) {
      // Parse header to find column indices
      const headers = parseCSVLine(lines[0], ';').map((h) => h.trim().toLowerCase().replace(/"/g, ''))
      dateIdx = headers.findIndex((h) => h === 'datum')
      if (dateIdx === -1) dateIdx = 0
      descIdx = headers.findIndex((h) => h === 'text' || h === 'beskrivning')
      if (descIdx === -1) descIdx = 3
      amountIdx = headers.findIndex((h) => h === 'belopp')
      if (amountIdx === -1) amountIdx = 4
      balanceIdx = headers.findIndex((h) => h === 'saldo')
      startIdx = 1
    }

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      const fields = parseCSVLine(line, ';').map((f) => f.trim().replace(/^"|"$/g, ''))

      if (fields.length < 5) {
        issues.push({ row: i + 1, message: 'Too few columns', severity: 'warning' })
        skippedRows++
        continue
      }

      const date = fields[dateIdx]
      const description = fields[descIdx] || 'Unknown'
      const amountStr = fields[amountIdx]
      const balanceStr = balanceIdx >= 0 && balanceIdx < fields.length ? fields[balanceIdx] : undefined

      if (!date || !amountStr) {
        const missing = []
        if (!date) missing.push('datum')
        if (!amountStr) missing.push('belopp')
        issues.push({ row: i + 1, message: `Saknar ${missing.join(' och ')}`, severity: 'warning' })
        skippedRows++
        continue
      }

      const amount = parseCommaDecimal(amountStr)
      if (isNaN(amount)) {
        issues.push({ row: i + 1, message: `Invalid amount: ${amountStr}`, severity: 'warning' })
        skippedRows++
        continue
      }

      const normalizedDate = normalizeDate(date)
      if (!normalizedDate) {
        issues.push({ row: i + 1, message: `Invalid date: ${date}`, severity: 'warning' })
        skippedRows++
        continue
      }

      const balance = balanceStr ? parseCommaDecimal(balanceStr) : null

      transactions.push({
        date: normalizedDate,
        description: description.trim(),
        amount,
        currency: 'SEK',
        balance: isNaN(balance as number) ? null : balance,
        reference: null,
        counterparty: null,
        raw_line: line,
      })
    }

    const dates = transactions.map((t) => t.date).sort()
    const totalDataRows = lines.length - startIdx

    return {
      format: 'lansforsakringar',
      format_name: 'Länsförsäkringar',
      transactions,
      date_from: dates[0] || null,
      date_to: dates[dates.length - 1] || null,
      issues,
      stats: {
        total_rows: totalDataRows,
        parsed_rows: transactions.length,
        skipped_rows: skippedRows,
        total_income: Math.round(transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0) * 100) / 100,
        total_expenses: Math.round(transactions.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0) * 100) / 100,
      },
    }
  },
}
