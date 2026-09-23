/**
 * Skandia CSV format parser
 *
 * Format: Semicolon-delimited, comma decimal separator
 * Columns: Datum, Beskrivning/Text, Belopp, Saldo (possibly Bankkategori)
 * Date format: YYYY-MM-DD
 * Encoding: UTF-8 or Windows-1252
 *
 * Notes:
 * - Header contains "beskrivning" (unique keyword not used by SEB/Handelsbanken)
 *   or "bankkategori" (Skandia-specific column)
 */

import type { BankFileFormat, BankFileParseResult, ParsedBankTransaction, BankFileParseIssue } from '../types'
import { prepareContent } from '../../shared/encoding'
import { normalizeDate } from '../date-utils'

function parseCommaDecimal(value: string): number {
  const cleaned = value.replace(/\s/g, '').replace(',', '.')
  return parseFloat(cleaned)
}

export const skandiaFormat: BankFileFormat = {
  id: 'skandia',
  name: 'Skandia',
  description: 'Skandia CSV (semicolon-delimited)',
  fileExtensions: ['.csv', '.txt'],

  detect(content: string, _filename: string): boolean {
    const prepared = prepareContent(content)
    const firstLine = prepared.split('\n')[0]?.toLowerCase().replace(/"/g, '') || ''
    if (!firstLine.includes(';')) return false

    const fields = firstLine.split(';').map((f) => f.trim())

    // "bankkategori" is unique to Skandia
    if (fields.some((f) => f.includes('bankkategori'))) return true

    // "beskrivning" as a standalone column header with semicolon delimiter
    // Must also have "datum" and "belopp" to confirm it's a bank export
    // Note: Handelsbanken uses "beskrivning" only as a fallback in descIdx logic,
    // but its header detection is "reskontradatum"/"transaktionsdatum" which is checked first
    if (
      fields.some((f) => f === 'beskrivning') &&
      fields.some((f) => f === 'datum') &&
      fields.some((f) => f === 'belopp')
    ) {
      return true
    }

    return false
  },

  parse(content: string): BankFileParseResult {
    const prepared = prepareContent(content)
    const lines = prepared.split('\n').filter((line) => line.trim() !== '')

    const transactions: ParsedBankTransaction[] = []
    const issues: BankFileParseIssue[] = []
    let skippedRows = 0

    // Parse header
    const headerLine = lines[0] || ''
    const headers = headerLine.split(';').map((h) => h.trim().toLowerCase().replace(/"/g, ''))

    const dateIdx = headers.findIndex((h) => h === 'datum')
    const descIdx = headers.findIndex((h) => h === 'beskrivning' || h === 'text')
    const amountIdx = headers.findIndex((h) => h === 'belopp')
    const balanceIdx = headers.findIndex((h) => h === 'saldo')

    if (dateIdx === -1 || amountIdx === -1) {
      issues.push({
        row: 1,
        message: 'Could not identify required columns (datum, belopp)',
        severity: 'error',
      })
      return {
        format: 'skandia',
        format_name: 'Skandia',
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
      format: 'skandia',
      format_name: 'Skandia',
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
