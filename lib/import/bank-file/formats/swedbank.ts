/**
 * Swedbank CSV format parser
 *
 * Format: Comma-delimited, PERIOD decimal separator (exception among Swedish banks!)
 * Columns (real export): Radnr, Clnr, Kontonr, Produkt, Valuta, Bokfdag, Transdag,
 *   Valutadag, Referens, Text, Belopp, Saldo
 * Date format: YYYY-MM-DD
 * Encoding: UTF-8 or Windows-1252
 *
 * Notes:
 * - First line is metadata (e.g. "* Transaktionsrapport Period ..."), SKIP it
 * - Second line is the actual header
 * - Uses period as decimal separator (unlike Nordea/SEB/Handelsbanken)
 * - Headers may be abbreviated (Clnr vs Clearingnummer, Bokfdag vs Bokföringsdatum)
 * - Referens column contains counterparty/payee name
 * - Text column contains transaction type (e.g. "Bg-bet. via internet")
 */

import type { BankFileFormat, BankFileParseResult, ParsedBankTransaction, BankFileParseIssue } from '../types'
import { prepareContent } from '../../shared/encoding'
import { normalizeDate } from '../date-utils'
import { parseCSVLine } from './nordea'

/**
 * Check if a header value matches any of the given patterns (case-insensitive)
 */
function matchesHeader(header: string, patterns: string[]): boolean {
  const h = header.toLowerCase()
  return patterns.some((p) => h === p || h.includes(p))
}

/**
 * Check if a line looks like a Swedbank header row
 */
function isSwedbankHeader(line: string): boolean {
  const lower = line.toLowerCase()
  return (
    // Full names (legacy or alternative exports)
    lower.includes('clearingnummer') || lower.includes('radnummer') ||
    // Abbreviated names (current export format)
    /\bradnr\b/.test(lower) || /\bclnr\b/.test(lower) ||
    // Combination of typical Swedbank columns
    (lower.includes('bokfdag') && lower.includes('belopp'))
  )
}

export const swedbankFormat: BankFileFormat = {
  id: 'swedbank',
  name: 'Swedbank',
  description: 'Swedbank CSV (comma-delimited, period decimal)',
  fileExtensions: ['.csv', '.txt'],

  detect(content: string, _filename: string): boolean {
    const prepared = prepareContent(content)
    const lines = prepared.split('\n')
    const line1 = lines[0] || ''
    const line2 = lines[1] || ''

    return isSwedbankHeader(line1) || isSwedbankHeader(line2)
  },

  parse(content: string): BankFileParseResult {
    const prepared = prepareContent(content)
    const lines = prepared.split('\n').filter((line) => line.trim() !== '')

    const transactions: ParsedBankTransaction[] = []
    const issues: BankFileParseIssue[] = []
    let skippedRows = 0

    // Find the header row: may be line 0 or line 1 (if line 0 is metadata)
    let headerLineIdx = -1
    for (let i = 0; i < Math.min(lines.length, 3); i++) {
      if (isSwedbankHeader(lines[i])) {
        headerLineIdx = i
        break
      }
    }

    if (headerLineIdx === -1) {
      issues.push({
        row: 1,
        message: 'Could not find Swedbank header row',
        severity: 'error',
      })
      return {
        format: 'swedbank',
        format_name: 'Swedbank',
        transactions: [],
        date_from: null,
        date_to: null,
        issues,
        stats: { total_rows: 0, parsed_rows: 0, skipped_rows: 0, total_income: 0, total_expenses: 0 },
      }
    }

    const headerLine = lines[headerLineIdx] || ''
    const headers = parseCSVLine(headerLine, ',').map((h) =>
      h.trim().toLowerCase().replace(/"/g, '')
    )

    // Find column indices: support both abbreviated and full header names
    const dateIdx = headers.findIndex((h) =>
      matchesHeader(h, ['bokfdag', 'bokföringsdatum', 'datum'])
    )
    const descIdx = headers.findIndex((h) => h === 'text' || h.includes('beskrivning'))
    const amountIdx = headers.findIndex((h) => h === 'belopp')
    const balanceIdx = headers.findIndex((h) => h === 'saldo')
    const referenceIdx = headers.findIndex((h) => h === 'referens')

    if (dateIdx === -1 || amountIdx === -1) {
      issues.push({
        row: headerLineIdx + 1,
        message: `Could not identify required columns (datum, belopp). Found headers: ${headers.join(', ')}`,
        severity: 'error',
      })
      return {
        format: 'swedbank',
        format_name: 'Swedbank',
        transactions: [],
        date_from: null,
        date_to: null,
        issues,
        stats: { total_rows: 0, parsed_rows: 0, skipped_rows: 0, total_income: 0, total_expenses: 0 },
      }
    }

    // Data starts after header
    for (let i = headerLineIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      const fields = parseCSVLine(line, ',').map((f) => f.trim().replace(/^"|"$/g, ''))

      const date = fields[dateIdx]
      const reference = referenceIdx >= 0 ? fields[referenceIdx]?.trim() : null
      const textDesc = descIdx >= 0 ? fields[descIdx]?.trim() : null
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

      // Swedbank uses PERIOD decimal separator
      const amount = parseFloat(amountStr.replace(/\s/g, ''))
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

      const balance = balanceStr ? parseFloat(balanceStr.replace(/\s/g, '')) : null

      // Build description: use reference (counterparty) as primary, text as secondary
      const description = reference && textDesc
        ? `${reference}: ${textDesc}`
        : reference || textDesc || 'Unknown'

      transactions.push({
        date: normalizedDate,
        description,
        amount,
        currency: 'SEK',
        balance: isNaN(balance as number) ? null : balance,
        reference: null,
        counterparty: reference || null,
        raw_line: line,
      })
    }

    const dates = transactions.map((t) => t.date).sort()

    return {
      format: 'swedbank',
      format_name: 'Swedbank',
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
