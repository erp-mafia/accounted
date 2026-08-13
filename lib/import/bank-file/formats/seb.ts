/**
 * SEB CSV format parser
 *
 * Format: Semicolon-delimited, comma decimal separator (parse also accepts
 *   comma-delimited variants via delimiter sniffing; detect stays strict)
 * Columns vary but typically: Bokföringsdag, Valutadag, Verifikationsnummer,
 *   Text/mottagare, Belopp, Saldo
 * Date format: YYYY-MM-DD
 * Encoding: UTF-8 or Windows-1252
 */

import type { BankFileFormat, BankFileParseResult, ParsedBankTransaction, BankFileParseIssue } from '../types'
import { prepareContent } from '../../shared/encoding'
import { normalizeDate } from '../date-utils'
import { parseCSVLine } from './nordea'

function parseCommaDecimal(value: string): number {
  const cleaned = value.replace(/\s/g, '').replace(',', '.')
  return parseFloat(cleaned)
}

export const sebFormat: BankFileFormat = {
  id: 'seb',
  name: 'SEB',
  description: 'SEB CSV (semicolon-delimited)',
  fileExtensions: ['.csv', '.txt'],

  detect(content: string, _filename: string): boolean {
    const prepared = prepareContent(content)
    const firstLine = prepared.split('\n')[0]?.toLowerCase() || ''
    // SEB uses semicolon delimiter. Header always has a bokföringsdag/bokföringsdatum
    // column plus either valutadag/valutadatum or verifikationsnummer. The secondary
    // check distinguishes SEB from Länsförsäkringar (which also has bokföringsdag).
    const hasBookingDate = /bokf(ö|o)ringsda(g|tum)/.test(firstLine)
    const hasSebSecondary =
      /valuta(dag|datum)/.test(firstLine) || firstLine.includes('verifikationsnummer')
    return firstLine.includes(';') && hasBookingDate && hasSebSecondary
  },

  parse(content: string): BankFileParseResult {
    const prepared = prepareContent(content)
    const lines = prepared.split('\n').filter((line) => line.trim() !== '')

    const transactions: ParsedBankTransaction[] = []
    const issues: BankFileParseIssue[] = []
    let skippedRows = 0

    // Parse header to find column indices. SEB normally exports
    // semicolon-delimited files, but some export surfaces use commas: sniff
    // the delimiter from the header line instead of assuming ';'.
    const headerLine = lines[0] || ''
    const semicolons = (headerLine.match(/;/g) || []).length
    const commas = (headerLine.match(/,/g) || []).length
    const delimiter = commas > semicolons ? ',' : ';'
    const headers = parseCSVLine(headerLine, delimiter).map((h) =>
      h.trim().toLowerCase().replace(/"/g, '')
    )

    // Find column indices dynamically
    let dateIdx = headers.findIndex((h) => /bokf(ö|o)ringsda(g|tum)/.test(h))
    if (dateIdx === -1) {
      // Lowest-priority tier: a bare "Datum" column. Only honored here in
      // parse (an explicit user choice), never in detect, so this profile
      // cannot steal files from other bank profiles during auto-detection.
      dateIdx = headers.findIndex((h) => h === 'datum')
    }
    const descIdx = headers.findIndex(
      (h) => h.includes('text') || h.includes('mottagare') || h.includes('beskrivning')
    )
    const amountIdx = headers.findIndex((h) => h.includes('belopp'))
    const balanceIdx = headers.findIndex((h) => h.includes('saldo'))

    if (dateIdx === -1 || amountIdx === -1) {
      issues.push({
        row: 1,
        message: 'Kunde inte identifiera nödvändiga kolumner (datum, belopp)',
        severity: 'error',
      })
      return {
        format: 'seb',
        format_name: 'SEB',
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
      const description = fields[descIdx >= 0 ? descIdx : dateIdx + 1] || 'Unknown'
      const amountStr = fields[amountIdx]
      const balanceStr = balanceIdx >= 0 ? fields[balanceIdx] : undefined

      if (!date || !amountStr) {
        issues.push({ row: i + 1, message: 'Obligatoriska fält saknas', severity: 'warning' })
        skippedRows++
        continue
      }

      const amount = parseCommaDecimal(amountStr)
      if (isNaN(amount)) {
        issues.push({ row: i + 1, message: `Ogiltigt belopp: ${amountStr}`, severity: 'warning' })
        skippedRows++
        continue
      }

      const normalizedDate = normalizeDate(date)
      if (!normalizedDate) {
        issues.push({ row: i + 1, message: `Ogiltigt datum: ${date}`, severity: 'warning' })
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

    return {
      format: 'seb',
      format_name: 'SEB',
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
