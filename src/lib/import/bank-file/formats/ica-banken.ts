/**
 * ICA Banken CSV format parser
 *
 * Format: Semicolon-delimited, comma decimal separator
 * Columns: Datum, Text, Belopp, Saldo
 * Date format: YYYY-MM-DD
 * Encoding: UTF-8 or Windows-1252
 *
 * Notes:
 * - ~6 metadata rows before the actual data (account info, period, etc.)
 * - Header row contains "datum" and "belopp"
 * - Must skip metadata lines to find the real header
 */

import type { BankFileFormat, BankFileParseResult, ParsedBankTransaction, BankFileParseIssue } from '../types'
import { prepareContent } from '../../shared/encoding'
import { normalizeDate } from '../date-utils'

function parseCommaDecimal(value: string): number {
  const cleaned = value.replace(/\s/g, '').replace(',', '.')
  return parseFloat(cleaned)
}

/**
 * Check if a line looks like the ICA Banken data header.
 * ICA Banken header: semicolon-delimited with "datum", "text", "belopp", "saldo"
 */
function isICAHeader(line: string): boolean {
  const lower = line.toLowerCase().replace(/"/g, '')
  if (!lower.includes(';')) return false
  const fields = lower.split(';').map((f) => f.trim())
  return (
    fields.some((f) => f === 'datum') &&
    fields.some((f) => f === 'belopp') &&
    fields.some((f) => f === 'text')
  )
}

/**
 * Detect ICA Banken format: semicolon-delimited file with metadata lines
 * before a header containing "datum" and "belopp".
 */
function detectICABanken(lines: string[]): boolean {
  // Look for a header row within the first ~10 lines (skipping metadata)
  let metadataCount = 0
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    if (isICAHeader(lines[i])) {
      // Must have at least 2 metadata rows before header to distinguish from
      // other semicolon-delimited formats (SEB, Handelsbanken, LF)
      return metadataCount >= 2
    }
    metadataCount++
  }
  return false
}

export const icaBankenFormat: BankFileFormat = {
  id: 'ica_banken',
  name: 'ICA Banken',
  description: 'ICA Banken CSV (semicolon-delimited, metadata rows before header)',
  fileExtensions: ['.csv', '.txt'],

  detect(content: string, _filename: string): boolean {
    const prepared = prepareContent(content)
    const lines = prepared.split('\n').filter((l) => l.trim() !== '')
    return detectICABanken(lines)
  },

  parse(content: string): BankFileParseResult {
    const prepared = prepareContent(content)
    const lines = prepared.split('\n').filter((line) => line.trim() !== '')

    const transactions: ParsedBankTransaction[] = []
    const issues: BankFileParseIssue[] = []
    let skippedRows = 0

    // Find the header row
    let headerLineIdx = -1
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      if (isICAHeader(lines[i])) {
        headerLineIdx = i
        break
      }
    }

    if (headerLineIdx === -1) {
      issues.push({
        row: 1,
        message: 'Could not find ICA Banken header row',
        severity: 'error',
      })
      return {
        format: 'ica_banken',
        format_name: 'ICA Banken',
        transactions: [],
        date_from: null,
        date_to: null,
        issues,
        stats: { total_rows: 0, parsed_rows: 0, skipped_rows: 0, total_income: 0, total_expenses: 0 },
      }
    }

    // Parse header columns
    const headers = lines[headerLineIdx].split(';').map((h) => h.trim().toLowerCase().replace(/"/g, ''))
    const dateIdx = headers.findIndex((h) => h === 'datum')
    const descIdx = headers.findIndex((h) => h === 'text')
    const amountIdx = headers.findIndex((h) => h === 'belopp')
    const balanceIdx = headers.findIndex((h) => h === 'saldo')

    if (dateIdx === -1 || amountIdx === -1) {
      issues.push({
        row: headerLineIdx + 1,
        message: 'Could not identify required columns (datum, belopp)',
        severity: 'error',
      })
      return {
        format: 'ica_banken',
        format_name: 'ICA Banken',
        transactions: [],
        date_from: null,
        date_to: null,
        issues,
        stats: { total_rows: 0, parsed_rows: 0, skipped_rows: 0, total_income: 0, total_expenses: 0 },
      }
    }

    for (let i = headerLineIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      const fields = line.split(';').map((f) => f.trim().replace(/^"|"$/g, ''))

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
      format: 'ica_banken',
      format_name: 'ICA Banken',
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
