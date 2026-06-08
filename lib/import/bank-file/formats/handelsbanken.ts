/**
 * Handelsbanken CSV format parser
 *
 * Format: Semicolon-delimited, comma decimal separator
 * Columns: Reskontradatum, Transaktionsdatum, Text, Belopp, Saldo
 * Date format: YYYY-MM-DD
 * Encoding: UTF-8 or Windows-1252
 *
 * Notes:
 * - Real Handelsbanken exports may prepend metadata rows (account number, period,
 *   balance) before the column header, so we scan the first lines for the header
 *   rather than assuming it is line 0.
 * - Fields may be double-quoted and a quoted "Text" field can itself contain a
 *   semicolon, so we use the quote-aware parseCSVLine rather than split(';').
 * - Negative amounts may use a Unicode minus (U+2212) or dash; normalizeMinusSign
 *   maps those to ASCII '-' so parseFloat does not return NaN.
 * - Filter rows with "Prel" prefix (preliminary/pending transactions).
 */

import type { BankFileFormat, BankFileParseResult, ParsedBankTransaction, BankFileParseIssue } from '../types'
import { prepareContent } from '../../shared/encoding'
import { normalizeDate } from '../date-utils'
import { parseCSVLine } from './nordea'
import { normalizeMinusSign } from './generic-csv'

// How many leading lines to scan for the header (allows for a metadata preamble)
const HEADER_SCAN_LIMIT = 15

function parseCommaDecimal(value: string): number {
  // Swedish format "1 234,56" / "-1 234,56", tolerating Unicode minus on negatives
  const cleaned = normalizeMinusSign(value).replace(/\s/g, '').replace(',', '.')
  return parseFloat(cleaned)
}

/**
 * Check if a line is the Handelsbanken transaction header: semicolon-delimited
 * and carrying a Handelsbanken date column plus the amount column. Specific
 * enough not to steal SEB / Nordea Företag / ICA / Skandia files, which use
 * different date labels (bokföringsdag, valutadag, datum).
 */
function isHandelsbankenHeader(line: string): boolean {
  const lower = line.toLowerCase()
  if (!lower.includes(';')) return false
  const hasDate = lower.includes('reskontradatum') || lower.includes('transaktionsdatum')
  const hasAmount = lower.includes('belopp')
  return hasDate && hasAmount
}

export const handelsbankenFormat: BankFileFormat = {
  id: 'handelsbanken',
  name: 'Handelsbanken',
  description: 'Handelsbanken CSV (semicolon-delimited)',
  fileExtensions: ['.csv', '.txt'],

  detect(content: string, _filename: string): boolean {
    const prepared = prepareContent(content)
    const lines = prepared.split('\n')
    return lines.slice(0, HEADER_SCAN_LIMIT).some(isHandelsbankenHeader)
  },

  parse(content: string): BankFileParseResult {
    const prepared = prepareContent(content)
    const lines = prepared.split('\n').filter((line) => line.trim() !== '')

    const transactions: ParsedBankTransaction[] = []
    const issues: BankFileParseIssue[] = []
    let skippedRows = 0

    const emptyResult = (issue: BankFileParseIssue): BankFileParseResult => ({
      format: 'handelsbanken',
      format_name: 'Handelsbanken',
      transactions: [],
      date_from: null,
      date_to: null,
      issues: [issue],
      stats: { total_rows: 0, parsed_rows: 0, skipped_rows: 0, total_income: 0, total_expenses: 0 },
    })

    // Find the header row, skipping any metadata preamble.
    let headerLineIdx = -1
    for (let i = 0; i < Math.min(lines.length, HEADER_SCAN_LIMIT); i++) {
      if (isHandelsbankenHeader(lines[i])) {
        headerLineIdx = i
        break
      }
    }

    if (headerLineIdx === -1) {
      return emptyResult({
        row: 1,
        message: 'Kunde inte hitta rubrikraden (Transaktionsdatum/Reskontradatum, Belopp).',
        severity: 'error',
      })
    }

    const headers = parseCSVLine(lines[headerLineIdx], ';').map((h) =>
      h.trim().toLowerCase().replace(/"/g, '')
    )

    const reskontraIdx = headers.findIndex((h) => h.includes('reskontradatum'))
    const txDateIdx = headers.findIndex((h) => h.includes('transaktionsdatum'))
    const descIdx = headers.findIndex((h) => h === 'text' || h.includes('beskrivning'))
    const amountIdx = headers.findIndex((h) => h.includes('belopp'))
    const balanceIdx = headers.findIndex((h) => h.includes('saldo'))

    // Prefer transaktionsdatum (real transaction date) over reskontradatum (booking date)
    const primaryDateIdx = txDateIdx >= 0 ? txDateIdx : reskontraIdx

    if (primaryDateIdx === -1 || amountIdx === -1) {
      return emptyResult({
        row: headerLineIdx + 1,
        message: 'Could not identify required columns',
        severity: 'error',
      })
    }

    for (let i = headerLineIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      const fields = parseCSVLine(line, ';').map((f) => f.trim().replace(/^"|"$/g, ''))

      const date = fields[primaryDateIdx]
      const description = descIdx >= 0 ? fields[descIdx] : 'Unknown'
      const amountStr = fields[amountIdx]
      const balanceStr = balanceIdx >= 0 ? fields[balanceIdx] : undefined

      // Skip preliminary transactions
      if (description?.toLowerCase().startsWith('prel')) {
        skippedRows++
        continue
      }

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
      format: 'handelsbanken',
      format_name: 'Handelsbanken',
      transactions,
      date_from: dates[0] || null,
      date_to: dates[dates.length - 1] || null,
      issues,
      stats: {
        total_rows: lines.length - headerLineIdx - 1,
        parsed_rows: transactions.length,
        skipped_rows: skippedRows,
        total_income: Math.round(transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0) * 100) / 100,
        total_expenses: Math.round(transactions.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0) * 100) / 100,
      },
    }
  },
}
