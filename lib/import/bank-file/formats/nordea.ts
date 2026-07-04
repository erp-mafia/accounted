/**
 * Nordea CSV format parser
 *
 * Format: Comma-delimited, comma decimal separator
 * Columns: Datum, Transaktion, Kategori, Belopp, Saldo
 * Date format: YYYY-MM-DD
 * Encoding: UTF-8 or Windows-1252
 *
 * Notes:
 * - Skip rows with "Reserverat" in Transaktion (pending transactions)
 * - Skip trailing blank lines
 */

import type { BankFileFormat, BankFileParseResult, ParsedBankTransaction, BankFileParseIssue } from '../types'
import { prepareContent } from '../../shared/encoding'
import { normalizeDate } from '../date-utils'

function parseCommaDecimal(value: string): number {
  // Swedish format: "1 234,56" or "-1 234,56"
  const cleaned = value.replace(/\s/g, '').replace(',', '.')
  return parseFloat(cleaned)
}

export const nordeaFormat: BankFileFormat = {
  id: 'nordea',
  name: 'Nordea',
  description: 'Nordea CSV (Datum, Transaktion, Kategori, Belopp, Saldo)',
  fileExtensions: ['.csv', '.txt'],

  detect(content: string, _filename: string): boolean {
    const prepared = prepareContent(content)
    const firstLine = prepared.split('\n')[0]?.toLowerCase() || ''
    // Nordea header: comma-delimited with "datum", "transaktion", "belopp"
    // Must NOT contain semicolons (that would be SEB or Handelsbanken)
    return (
      !firstLine.includes(';') &&
      firstLine.includes('datum') &&
      firstLine.includes('transaktion') &&
      firstLine.includes('belopp')
    )
  },

  parse(content: string): BankFileParseResult {
    const prepared = prepareContent(content)
    const lines = prepared.split('\n').filter((line) => line.trim() !== '')

    const transactions: ParsedBankTransaction[] = []
    const issues: BankFileParseIssue[] = []
    let skippedRows = 0

    // Skip header row
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      // Parse CSV with comma delimiter
      // Handle quoted fields that may contain commas
      const fields = parseCSVLine(line, ',')

      if (fields.length < 4) {
        issues.push({ row: i + 1, message: 'Too few columns', severity: 'warning' })
        skippedRows++
        continue
      }

      const [date, description, _category, amountStr, balanceStr] = fields

      // Skip reserved/pending transactions
      if (description?.toLowerCase().includes('reserverat')) {
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
        description: description?.trim() || 'Unknown',
        amount,
        currency: 'SEK',
        balance: isNaN(balance as number) ? null : balance,
        reference: null,
        counterparty: null,
        raw_line: line,
      })
    }

    const dates = transactions.map((t) => t.date).sort()

    return {
      format: 'nordea',
      format_name: 'Nordea',
      transactions,
      date_from: dates[0] || null,
      date_to: dates[dates.length - 1] || null,
      issues,
      stats: {
        total_rows: lines.length - 1,
        parsed_rows: transactions.length,
        skipped_rows: skippedRows,
        total_income: Math.round(transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0) * 100) / 100,
        total_expenses: Math.round(transactions.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0) * 100) / 100,
      },
    }
  },
}

/**
 * Parse a CSV line respecting quoted fields
 */
function parseCSVLine(line: string, delimiter: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++ // Skip escaped quote
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === delimiter && !inQuotes) {
      fields.push(current)
      current = ''
    } else {
      current += char
    }
  }

  // Push last field: if inQuotes is still true, the quote was unclosed.
  // Treat the accumulated data as-is rather than silently merging fields.
  fields.push(current)
  return fields
}

export { parseCSVLine }
