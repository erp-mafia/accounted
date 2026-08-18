/**
 * Lunar CSV format parser
 *
 * Format: Comma-delimited, comma decimal separator (amounts are quoted)
 * Columns (2026 export): Date, Time, Title, Amount, Balance, Transaction ID
 * Columns (legacy): Date, Text, Amount, Balance
 * Date format: YYYY-MM-DD
 * Encoding: UTF-8, may start with a BOM
 *
 * Notes:
 * - English headers distinguish Lunar from Nordea (Swedish headers)
 * - Amounts use comma as decimal separator but are quoted since the file
 *   delimiter is also comma
 * - The delimiter is sniffed from the header line: the documented export is
 *   comma-delimited, but a semicolon- or tab-delimited copy of the same
 *   header set (a spreadsheet re-save, a localized export) carries the same
 *   distinctive English columns and must not fall through to the manual
 *   mapping flow, where the Time column used to be picked as the description
 *   (issue #1671)
 * - Thousand separator is a space in the 2026 export (e.g. "12 345,00");
 *   legacy exports used a period (e.g. "1.234,56"). Both are handled.
 */

import type { BankFileFormat, BankFileParseResult, ParsedBankTransaction, BankFileParseIssue } from '../types'
import { prepareContent } from '../../shared/encoding'
import { normalizeDate } from '../date-utils'
import { parseCSVLine } from './nordea'

const LUNAR_DELIMITERS = [',', ';', '\t']

/**
 * Sniff the field delimiter from the header line. Comma is the documented
 * Lunar export and wins ties; semicolon and tab are accepted when they split
 * the header into more cells.
 */
function sniffLunarDelimiter(headerLine: string): string {
  let best = ','
  let bestCount = parseCSVLine(headerLine, ',').length
  for (const delimiter of LUNAR_DELIMITERS.slice(1)) {
    const count = parseCSVLine(headerLine, delimiter).length
    if (count > bestCount) {
      best = delimiter
      bestCount = count
    }
  }
  return best
}

function parseLunarHeader(headerLine: string, delimiter: string): string[] {
  return parseCSVLine(headerLine, delimiter).map((h) => h.trim().toLowerCase().replace(/"/g, ''))
}

/**
 * The Lunar header set: date, a description column ("title" in the 2026
 * export, "text" in the legacy one), amount and balance, matched as whole
 * cells so a Swedish "Datum" export or an English file with e.g. "Running
 * balance" is never claimed. Exact cells are also what parse() resolves on,
 * so detect() can never accept a header parse() then rejects.
 */
function isLunarHeader(cells: string[]): boolean {
  return (
    cells.includes('date') &&
    (cells.includes('title') || cells.includes('text')) &&
    cells.includes('amount') &&
    cells.includes('balance')
  )
}

function parseLunarAmount(value: string): number {
  // Lunar format: "12 345,00" (2026, space thousands) or "1.234,56" (legacy,
  // period thousands). Strip all whitespace (including NBSP U+00A0 and narrow
  // NBSP U+202F) and periods, then convert the comma decimal to a period.
  const cleaned = value.replace(/[\s\u00A0\u202F.]/g, '').replace(',', '.')
  if (cleaned === '') return NaN
  // Number() rejects trailing garbage that parseFloat would silently accept
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : NaN
}

export const lunarFormat: BankFileFormat = {
  id: 'lunar',
  name: 'Lunar',
  description: 'Lunar CSV (comma-delimited, English headers)',
  fileExtensions: ['.csv', '.txt'],

  detect(content: string, _filename: string): boolean {
    const prepared = prepareContent(content)
    const firstLine = prepared.split('\n')[0] || ''
    // Lunar: English headers "date", "amount", "balance" and a description
    // column: "title" (2026 export) or "text" (legacy export). Delimiter is
    // sniffed (comma, semicolon or tab); the Swedish-header banks are all
    // checked before this format, so the English set is what distinguishes it.
    return isLunarHeader(parseLunarHeader(firstLine, sniffLunarDelimiter(firstLine)))
  },

  parse(content: string): BankFileParseResult {
    const prepared = prepareContent(content)
    const lines = prepared.split('\n').filter((line) => line.trim() !== '')

    const transactions: ParsedBankTransaction[] = []
    const issues: BankFileParseIssue[] = []
    let skippedRows = 0

    // Parse header; the delimiter is sniffed from it and reused for every row
    const headerLine = lines[0] || ''
    const delimiter = sniffLunarDelimiter(headerLine)
    const headers = parseLunarHeader(headerLine, delimiter)

    const dateIdx = headers.findIndex((h) => h === 'date')
    // "title" is the 2026 export's description column; "text" is the legacy one
    const titleIdx = headers.findIndex((h) => h === 'title')
    const descIdx = titleIdx !== -1 ? titleIdx : headers.findIndex((h) => h === 'text')
    const amountIdx = headers.findIndex((h) => h === 'amount')
    const balanceIdx = headers.findIndex((h) => h === 'balance')

    if (dateIdx === -1 || amountIdx === -1) {
      issues.push({
        row: 1,
        message: 'Could not identify required columns (date, amount)',
        severity: 'error',
      })
      return {
        format: 'lunar',
        format_name: 'Lunar',
        transactions: [],
        date_from: null,
        date_to: null,
        issues,
        stats: { total_rows: 0, parsed_rows: 0, skipped_rows: 0, total_income: 0, total_expenses: 0 },
      }
    }

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      const fields = parseCSVLine(line, delimiter).map((f) => f.trim().replace(/^"|"$/g, ''))

      const date = fields[dateIdx]
      const description = descIdx >= 0 ? fields[descIdx] : 'Unknown'
      const amountStr = fields[amountIdx]
      const balanceStr = balanceIdx >= 0 ? fields[balanceIdx] : undefined

      if (!date || !amountStr) {
        const missing = []
        if (!date) missing.push('datum')
        if (!amountStr) missing.push('belopp')
        issues.push({ row: i + 1, message: `Saknar ${missing.join(' och ')}`, severity: 'warning' })
        skippedRows++
        continue
      }

      const amount = parseLunarAmount(amountStr)
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

      const balance = balanceStr ? parseLunarAmount(balanceStr) : null

      transactions.push({
        date: normalizedDate,
        description: (description || 'Unknown').trim(),
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
      format: 'lunar',
      format_name: 'Lunar',
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
