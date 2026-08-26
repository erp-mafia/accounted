/**
 * SEB CSV format parser
 *
 * Format: Semicolon-delimited, comma decimal separator (parse also accepts
 *   comma-delimited variants via delimiter sniffing; detect stays strict)
 * Two layouts, depending on which internet-bank page exported the file:
 *   - Kontoutdrag: Bokföringsdag/Bokföringsdatum, Valutadag, Verifikationsnummer,
 *     Text/mottagare, Belopp, Saldo
 *   - Transaktioner: Bokförd, Valutadatum, Text, Typ, Insättningar, Uttag,
 *     Bokfört saldo (dot decimal separator, amount split across two columns
 *     where Uttag rows carry their own minus sign)
 * Date format: YYYY-MM-DD
 * Encoding: UTF-8 (optionally with BOM) or Windows-1252
 */

import type { BankFileFormat, BankFileParseResult, ParsedBankTransaction, BankFileParseIssue } from '../types'
import { roundOre } from '@/lib/money'
import { prepareContent } from '../../shared/encoding'
import { normalizeDate } from '../date-utils'
import { parseCSVLine } from './nordea'

function parseCommaDecimal(value: string): number {
  const cleaned = value.replace(/\s/g, '').replace(',', '.')
  return parseFloat(cleaned)
}

const DEPOSIT_COLUMN_RE = /^ins(ä|a)ttning/
const WITHDRAWAL_COLUMN_RE = /^uttag/

/**
 * The Transaktioner web export: a "Bokförd" (or Valutadatum) date column plus
 * the amount split across Insättningar/Uttag. The split amount pair is unique
 * to this layout among the supported semicolon formats, so requiring both
 * columns cannot steal files from other bank profiles.
 */
function isTransaktionerHeader(headers: string[]): boolean {
  const hasDate =
    headers.some((h) => h === 'bokförd' || h === 'bokford') ||
    headers.some((h) => /valuta(dag|datum)/.test(h))
  return (
    hasDate &&
    headers.some((h) => DEPOSIT_COLUMN_RE.test(h)) &&
    headers.some((h) => WITHDRAWAL_COLUMN_RE.test(h))
  )
}

export const sebFormat: BankFileFormat = {
  id: 'seb',
  name: 'SEB',
  description: 'SEB CSV (semicolon-delimited)',
  fileExtensions: ['.csv', '.txt'],

  detect(content: string, _filename: string): boolean {
    const prepared = prepareContent(content)
    const firstLine = prepared.split('\n')[0]?.toLowerCase() || ''
    if (!firstLine.includes(';')) return false
    // Kontoutdrag layout: a bokföringsdag/bokföringsdatum column plus either
    // valutadag/valutadatum or verifikationsnummer. The secondary check
    // distinguishes SEB from Länsförsäkringar (which also has bokföringsdag).
    const hasBookingDate = /bokf(ö|o)ringsda(g|tum)/.test(firstLine)
    const hasSebSecondary =
      /valuta(dag|datum)/.test(firstLine) || firstLine.includes('verifikationsnummer')
    if (hasBookingDate && hasSebSecondary) return true

    const headers = firstLine.split(';').map((h) => h.trim().replace(/"/g, ''))
    return isTransaktionerHeader(headers)
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
      // Transaktioner layout: the booking date column is just "Bokförd".
      dateIdx = headers.findIndex((h) => h === 'bokförd' || h === 'bokford')
    }
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
    // Transaktioner layout: no Belopp column; the amount is split across
    // Insättningar (positive) and Uttag (exported with its own minus sign).
    const depositIdx = amountIdx === -1 ? headers.findIndex((h) => DEPOSIT_COLUMN_RE.test(h)) : -1
    const withdrawalIdx =
      amountIdx === -1 ? headers.findIndex((h) => WITHDRAWAL_COLUMN_RE.test(h)) : -1
    const hasSplitAmount = depositIdx !== -1 && withdrawalIdx !== -1
    const balanceIdx = headers.findIndex((h) => h.includes('saldo'))

    if (dateIdx === -1 || (amountIdx === -1 && !hasSplitAmount)) {
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
      const amountStr = hasSplitAmount
        ? fields[depositIdx] || fields[withdrawalIdx]
        : fields[amountIdx]
      const balanceStr = balanceIdx >= 0 ? fields[balanceIdx] : undefined

      if (!date || !amountStr) {
        issues.push({ row: i + 1, message: 'Obligatoriska fält saknas', severity: 'warning' })
        skippedRows++
        continue
      }

      let amount: number
      if (hasSplitAmount) {
        const deposit = fields[depositIdx] ? parseCommaDecimal(fields[depositIdx]) : 0
        const rawWithdrawal = fields[withdrawalIdx] ? parseCommaDecimal(fields[withdrawalIdx]) : 0
        // Uttag values carry their own minus sign in SEB's export; normalize
        // so a variant exporting magnitudes still lands as an expense.
        const withdrawal = rawWithdrawal > 0 ? -rawWithdrawal : rawWithdrawal
        amount = roundOre(deposit + withdrawal)
      } else {
        amount = parseCommaDecimal(amountStr)
      }
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
