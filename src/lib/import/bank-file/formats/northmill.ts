/**
 * Northmill CSV format parser
 *
 * Format: Comma-delimited, comma decimal separator (amounts are quoted)
 * Preamble: 5 metadata rows (Kontonummer, Saldo, Kontohavare, Org. Nr, Period)
 *           followed by blank lines before the transaction header.
 * Header: Bokföringsdag,Beskrivning,Belopp,Saldo,Valuta
 * Date format: YYYY-MM-DD
 * Encoding: UTF-8
 *
 * Notes:
 * - Negative amounts use Unicode minus sign (U+2212 "−"), not ASCII hyphen.
 *   The parser normalizes the minus before calling parseFloat.
 */

import type { BankFileFormat, BankFileParseResult, ParsedBankTransaction, BankFileParseIssue } from '../types'
import { prepareContent } from '../../shared/encoding'
import { normalizeDate } from '../date-utils'
import { parseCSVLine } from './nordea'
import { normalizeMinusSign } from './generic-csv'

const HEADER_KEYWORDS = ['bokföringsdag', 'beskrivning', 'belopp']

function isNorthmillHeader(line: string): boolean {
  const lower = line.toLowerCase()
  if (lower.includes(';')) return false
  return HEADER_KEYWORDS.every((kw) => lower.includes(kw))
}

function parseAmount(value: string): number {
  // Northmill: "−139,00" (Unicode minus) or "400000,00" (no thousand separator on positives)
  const cleaned = normalizeMinusSign(value).replace(/\s/g, '').replace(',', '.')
  return parseFloat(cleaned)
}

export const northmillFormat: BankFileFormat = {
  id: 'northmill',
  name: 'Northmill',
  description: 'Northmill kontoutdrag (CSV med metadata-rader och Unicode-minus)',
  fileExtensions: ['.csv', '.txt'],

  detect(content: string, _filename: string): boolean {
    const prepared = prepareContent(content)
    const lines = prepared.split('\n')
    // Northmill preamble's first non-empty line is "Kontonummer,<account>"
    const firstNonEmpty = lines.find((l) => l.trim() !== '') || ''
    if (!/^kontonummer\s*,/i.test(firstNonEmpty.trim())) return false
    // Also look for the transaction header within the first ~20 lines to be sure
    return lines.slice(0, 20).some(isNorthmillHeader)
  },

  parse(content: string): BankFileParseResult {
    const prepared = prepareContent(content)
    const rawLines = prepared.split('\n')

    const transactions: ParsedBankTransaction[] = []
    const issues: BankFileParseIssue[] = []
    let skippedRows = 0

    const headerIdx = rawLines.findIndex(isNorthmillHeader)
    if (headerIdx === -1) {
      return {
        format: 'northmill',
        format_name: 'Northmill',
        transactions: [],
        date_from: null,
        date_to: null,
        issues: [{ row: 0, message: 'Kunde inte hitta rubrikraden (Bokföringsdag, Beskrivning, Belopp).', severity: 'error' }],
        stats: { total_rows: 0, parsed_rows: 0, skipped_rows: 0, total_income: 0, total_expenses: 0 },
      }
    }

    const headers = parseCSVLine(rawLines[headerIdx], ',').map((h) => h.trim().toLowerCase().replace(/"/g, ''))
    const dateIdx = headers.findIndex((h) => h.includes('bokföringsdag') || h.includes('bokforingsdag'))
    const descIdx = headers.findIndex((h) => h.includes('beskrivning'))
    const amountIdx = headers.findIndex((h) => h.includes('belopp'))
    const balanceIdx = headers.findIndex((h) => h.includes('saldo'))

    if (dateIdx === -1 || descIdx === -1 || amountIdx === -1) {
      issues.push({
        row: headerIdx + 1,
        message: 'Rubrikraden saknar nödvändiga kolumner (Bokföringsdag, Beskrivning, Belopp).',
        severity: 'error',
      })
      return {
        format: 'northmill',
        format_name: 'Northmill',
        transactions: [],
        date_from: null,
        date_to: null,
        issues,
        stats: { total_rows: 0, parsed_rows: 0, skipped_rows: 0, total_income: 0, total_expenses: 0 },
      }
    }

    for (let i = headerIdx + 1; i < rawLines.length; i++) {
      const line = rawLines[i].trim()
      if (!line) continue

      const fields = parseCSVLine(line, ',').map((f) => f.trim().replace(/^"|"$/g, ''))
      const dateStr = fields[dateIdx]
      const description = fields[descIdx] || 'Unknown'
      const amountStr = fields[amountIdx]
      const balanceStr = balanceIdx >= 0 ? fields[balanceIdx] : undefined

      if (!dateStr || !amountStr) {
        const missing: string[] = []
        if (!dateStr) missing.push('datum')
        if (!amountStr) missing.push('belopp')
        issues.push({ row: i + 1, message: `Saknar ${missing.join(' och ')}`, severity: 'warning' })
        skippedRows++
        continue
      }

      const date = normalizeDate(dateStr)
      if (!date) {
        issues.push({ row: i + 1, message: `Ogiltigt datumformat: ${dateStr}`, severity: 'warning' })
        skippedRows++
        continue
      }

      const amount = parseAmount(amountStr)
      if (isNaN(amount)) {
        issues.push({ row: i + 1, message: `Ogiltigt belopp: ${amountStr}`, severity: 'warning' })
        skippedRows++
        continue
      }

      let balance: number | null = null
      if (balanceStr) {
        const b = parseAmount(balanceStr)
        balance = isNaN(b) ? null : b
      }

      transactions.push({
        date,
        description: description.trim(),
        amount,
        currency: 'SEK',
        balance,
        reference: null,
        counterparty: null,
        raw_line: line,
      })
    }

    const dates = transactions.map((t) => t.date).sort()

    return {
      format: 'northmill',
      format_name: 'Northmill',
      transactions,
      date_from: dates[0] || null,
      date_to: dates[dates.length - 1] || null,
      issues,
      stats: {
        total_rows: rawLines.length - headerIdx - 1,
        parsed_rows: transactions.length,
        skipped_rows: skippedRows,
        total_income: Math.round(transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0) * 100) / 100,
        total_expenses: Math.round(transactions.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0) * 100) / 100,
      },
    }
  },
}
