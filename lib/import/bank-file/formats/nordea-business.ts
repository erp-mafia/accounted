/**
 * Nordea Business CSV format parser
 *
 * Supports multiple Nordea Business / Internetbanken Företag export formats:
 *
 * Format A (classic): Semicolon-delimited, comma decimal separator
 *   Columns: Bokföringsdag, Belopp, Avsändare, Mottagare, Namn, Rubrik, Saldo, Valuta
 *
 * Format B (alternate): Semicolon-delimited
 *   Columns: Bokföringsdag, Värdedag, Betalningstyp, Betalare/Mottagare, Meddelande/Referens, Belopp, Saldo
 *
 * Format C (simple): Semicolon-delimited
 *   Columns: Bokföringsdatum, Valutadatum, Text, Belopp, Saldo
 *
 * Format D (Datum variant): Semicolon-delimited, slash dates
 *   Columns: Datum, Belopp, Avsändare, Mottagare, Namn, Ytterligare detaljer, Meddelande, Egna anteckningar, Saldo, Valuta
 *   Date format: YYYY/MM/DD (normalized to YYYY-MM-DD)
 *
 * Date format: YYYY-MM-DD (YYYY/MM/DD also accepted and normalized)
 * Encoding: UTF-8 or Windows-1252
 */

import type { BankFileFormat, BankFileParseResult, ParsedBankTransaction, BankFileParseIssue } from '../types'
import { prepareContent } from '../../shared/encoding'
import { normalizeDate } from '../date-utils'

function parseCommaDecimal(value: string): number {
  const cleaned = value.replace(/\s/g, '').replace(',', '.')
  return parseFloat(cleaned)
}

export const nordeaBusinessFormat: BankFileFormat = {
  id: 'nordea_business',
  name: 'Nordea Företag',
  description: 'Nordea Företag CSV (semicolon-delimited business banking export)',
  fileExtensions: ['.csv', '.txt'],

  detect(content: string, _filename: string): boolean {
    const prepared = prepareContent(content)
    const firstLine = prepared.split('\n')[0]?.toLowerCase() || ''

    if (!firstLine.includes(';')) return false

    // Must have a date column that looks like Nordea Business
    const hasNordeaDateCol =
      firstLine.includes('bokföringsdag') ||
      firstLine.includes('bokforingsdag') ||
      firstLine.includes('bokföringsdatum') ||
      firstLine.includes('bokforingsdatum')

    // Format D: standalone "Datum" column (not reskontradatum/transaktionsdatum)
    // Check parsed headers for exact match to avoid false positives with Handelsbanken
    // Note: firstLine is already lowercased, so no need for additional toLowerCase()
    const headersDetect = firstLine.split(';').map(h => h.replace(/"/g, '').trim())
    const hasStandaloneDatum = headersDetect.some(h => h === 'datum')

    if (!hasNordeaDateCol && !hasStandaloneDatum) return false

    // Exclude SEB (which also has bokföringsdag/bokföringsdatum but adds valutadag/verifikationsnummer)
    if (firstLine.includes('valutadag') || firstLine.includes('verifikationsnummer')) return false

    // Exclude Länsförsäkringar (has separate "datum" column alongside "bokföringsdag" + "typ")
    // LF headers are quoted: "Datum";"Bokföringsdag";"Typ";"Text";"Belopp";"Saldo"
    const headers = firstLine.split(';').map(h => h.replace(/"/g, '').trim())
    const hasSeparateDatum = headers.some(h => h === 'datum')
    if (hasSeparateDatum && headers.some(h => h === 'typ')) return false

    // Accept any of these Nordea Business patterns:
    return (
      // Pattern 1: "rubrik" column (classic format)
      firstLine.includes('rubrik') ||
      // Pattern 2: separate "avsändare" + "mottagare" columns
      (firstLine.includes('avsändare') && firstLine.includes('mottagare')) ||
      (firstLine.includes('avsandare') && firstLine.includes('mottagare')) ||
      // Pattern 3: "betalare" (e.g., combined "Betalare/Mottagare" column)
      firstLine.includes('betalare') ||
      // Pattern 4: "betalningstyp" column (Nordea business payment type indicator)
      firstLine.includes('betalningstyp') ||
      // Pattern 5: simple format with "text" + "belopp" (for Bokföringsdatum;...;Text;Belopp;Saldo)
      (firstLine.includes('text') && firstLine.includes('belopp'))
    )
  },

  parse(content: string): BankFileParseResult {
    const prepared = prepareContent(content)
    const lines = prepared.split('\n').filter((line) => line.trim() !== '')

    const transactions: ParsedBankTransaction[] = []
    const issues: BankFileParseIssue[] = []
    let skippedRows = 0

    // Parse header to find column indices dynamically
    const headerLine = lines[0] || ''
    const headers = headerLine.split(';').map((h) => h.trim().toLowerCase().replace(/"/g, ''))

    // Date column: accept multiple Nordea naming patterns (including standalone "datum" for Format D)
    const dateIdx = headers.findIndex(
      (h) => h.includes('bokföringsdag') || h.includes('bokforingsdag') ||
             h.includes('bokföringsdatum') || h.includes('bokforingsdatum') ||
             h === 'datum'
    )
    const amountIdx = headers.findIndex((h) => h === 'belopp' || h.includes('belopp'))
    const senderIdx = headers.findIndex((h) => h.includes('avsändare') || h.includes('avsandare'))
    // Receiver: standalone "mottagare" (not combined "betalare/mottagare")
    const receiverIdx = headers.findIndex(
      (h) => h.includes('mottagare') && !h.includes('betalare') && !h.includes('/')
    )
    // Combined "Betalare/Mottagare" column
    const combinedPartyIdx = headers.findIndex(
      (h) => (h.includes('betalare') && h.includes('mottagare')) || h === 'betalare/mottagare'
    )
    const nameIdx = headers.findIndex((h) => h === 'namn')
    const subjectIdx = headers.findIndex((h) => h === 'rubrik')
    // Description fallbacks: "text", "meddelande", "meddelande/referens", "beskrivning"
    const textIdx = headers.findIndex(
      (h) => h === 'text' || h.includes('meddelande') || h.includes('beskrivning')
    )
    const ytterligareDetaljerIdx = headers.findIndex((h) => h === 'ytterligare detaljer')
    const paymentTypeIdx = headers.findIndex((h) => h.includes('betalningstyp'))
    const balanceIdx = headers.findIndex((h) => h === 'saldo' || h.includes('saldo'))
    const currencyIdx = headers.findIndex((h) => h === 'valuta' || h.includes('valuta'))

    if (dateIdx === -1 || amountIdx === -1) {
      issues.push({
        row: 1,
        message: 'Could not identify required columns (Bokföringsdag/Bokföringsdatum/Datum, Belopp)',
        severity: 'error',
      })
      return {
        format: 'nordea_business',
        format_name: 'Nordea Företag',
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

      const date = fields[dateIdx]?.trim()
      const amountStr = fields[amountIdx]

      if (!date || !amountStr) {
        issues.push({ row: i + 1, message: 'Missing required fields', severity: 'warning' })
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

      // Build description from available columns with fallback chain
      const name = nameIdx >= 0 ? fields[nameIdx]?.trim() : ''
      const subject = subjectIdx >= 0 ? fields[subjectIdx]?.trim() : ''
      const text = textIdx >= 0 ? fields[textIdx]?.trim() : ''
      const paymentType = paymentTypeIdx >= 0 ? fields[paymentTypeIdx]?.trim() : ''
      const ytterligareDetaljer = ytterligareDetaljerIdx >= 0 ? fields[ytterligareDetaljerIdx]?.trim() : ''

      let description: string
      if (name || subject) {
        // Classic format: Namn - Rubrik
        description = [name, subject].filter(Boolean).join(' - ') || 'Unknown'
      } else if (ytterligareDetaljer) {
        // Format D: "Ytterligare detaljer" has the full description
        description = ytterligareDetaljer
      } else if (text) {
        // Alternate format: use Text/Meddelande column
        description = [paymentType, text].filter(Boolean).join(' - ') || text
      } else {
        description = 'Unknown'
      }

      // Counterparty from sender/receiver or combined column
      let counterparty: string | null = null
      if (combinedPartyIdx >= 0) {
        counterparty = fields[combinedPartyIdx]?.trim() || null
      } else {
        const sender = senderIdx >= 0 ? fields[senderIdx]?.trim() : null
        const receiver = receiverIdx >= 0 ? fields[receiverIdx]?.trim() : null
        counterparty = (amount > 0 ? sender : receiver) || null
      }

      const balance = balanceIdx >= 0 && fields[balanceIdx] ? parseCommaDecimal(fields[balanceIdx]) : null
      const currency = currencyIdx >= 0 && fields[currencyIdx] ? fields[currencyIdx].trim() : 'SEK'

      transactions.push({
        date: normalizedDate,
        description,
        amount,
        currency: currency || 'SEK',
        balance: isNaN(balance as number) ? null : balance,
        reference: null,
        counterparty: counterparty || null,
        raw_line: line,
      })
    }

    const dates = transactions.map((t) => t.date).sort()

    return {
      format: 'nordea_business',
      format_name: 'Nordea Företag',
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
