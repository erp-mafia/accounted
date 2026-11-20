/**
 * Avanza transaction export parser (Sparkonto and other Avanza accounts)
 *
 * Format: Semicolon-delimited, comma decimal separator, UTF-8 with BOM
 * Header: Datum;Konto;Typ av transaktion;Värdepapper/beskrivning;Antal;Kurs;
 *         Belopp;Transaktionsvaluta;Courtage;Valutakurs;Instrumentvaluta;ISIN;Resultat
 *         (older exports: ...;Belopp;Courtage;Valuta;ISIN;Resultat)
 * Date format: YYYY-MM-DD
 * Row order: newest first
 *
 * Notes:
 * - "Belopp" is the signed cash movement on the account (Insättning positive,
 *   Uttag negative), so it maps straight onto the transaction amount.
 * - "Typ av transaktion" carries the meaning (Inlåningsränta, Insättning,
 *   Uttag, Intern överföring); "Värdepapper/beskrivning" is empty on interest
 *   rows. The description joins the two so interest rows are never blank.
 * - One export can span several Avanza accounts (the "Konto" column). The
 *   import books every row to one bank account, so a mixed file is refused:
 *   merging two accounts' flows would break that account's reconciliation.
 * - Fields are split quote-aware, so a quoted description holding a
 *   semicolon cannot shift Belopp into another column.
 */

import type { BankFileFormat, BankFileParseResult, ParsedBankTransaction, BankFileParseIssue } from '../types'
import { parseSwedishAmount } from '@/lib/money'
import { prepareContent } from '../../shared/encoding'
import { normalizeDate } from '../date-utils'
import { parseCSVLine } from './nordea'
import { finishParseResult } from '../parse-result'

function splitHeader(line: string): string[] {
  return parseCSVLine(line, ';').map((h) => h.trim().toLowerCase())
}

function isAvanzaHeader(fields: string[]): boolean {
  return (
    fields.includes('typ av transaktion') &&
    fields.includes('värdepapper/beskrivning') &&
    fields.includes('belopp')
  )
}

function buildDescription(type: string, text: string): string {
  if (!text) return type || 'Okänd'
  if (!type || text.toLowerCase().startsWith(type.toLowerCase())) return text
  return `${type}, ${text}`
}

export const avanzaFormat: BankFileFormat = {
  id: 'avanza',
  name: 'Avanza',
  description: 'Avanza transaktionsexport (CSV, t.ex. Sparkonto)',
  fileExtensions: ['.csv', '.txt'],

  detect(content: string, _filename: string): boolean {
    const firstLine = prepareContent(content).split('\n')[0] || ''
    if (!firstLine.includes(';')) return false
    return isAvanzaHeader(splitHeader(firstLine))
  },

  parse(content: string): BankFileParseResult {
    const prepared = prepareContent(content)
    const lines = prepared.split('\n').filter((line) => line.trim() !== '')

    const transactions: ParsedBankTransaction[] = []
    const issues: BankFileParseIssue[] = []
    let skippedRows = 0

    const headers = splitHeader(lines[0] || '')
    if (!isAvanzaHeader(headers)) {
      issues.push({
        row: 1,
        message: 'Kunde inte hitta Avanzas kolumner (Typ av transaktion, Värdepapper/beskrivning, Belopp)',
        severity: 'error',
      })
      return {
        format: 'avanza',
        format_name: 'Avanza',
        transactions: [],
        date_from: null,
        date_to: null,
        issues,
        stats: { total_rows: 0, parsed_rows: 0, skipped_rows: 0, total_income: 0, total_expenses: 0 },
      }
    }

    const dateIdx = headers.indexOf('datum')
    const accountIdx = headers.indexOf('konto')
    const typeIdx = headers.indexOf('typ av transaktion')
    const textIdx = headers.indexOf('värdepapper/beskrivning')
    const amountIdx = headers.indexOf('belopp')
    // Only the newer export names the currency of Belopp. The older one's
    // "Valuta" sits with Courtage and ISIN, the security's currency, while
    // Belopp is the kronor that moved on the account: read as the row's
    // currency it would turn a US share bought on an ISK into a USD row.
    const currencyIdx = headers.indexOf('transaktionsvaluta')

    const accounts = new Set<string>()

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      const fields = parseCSVLine(line, ';').map((f) => f.trim())

      const date = normalizeDate(dateIdx >= 0 ? fields[dateIdx] : undefined)
      if (!date) {
        issues.push({ row: i + 1, message: `Ogiltigt datum: ${fields[dateIdx] ?? ''}`, severity: 'warning' })
        skippedRows++
        continue
      }

      const amountStr = fields[amountIdx]
      // An empty or "-" Belopp on a whole row: a row that moved no money on
      // the account, such as a värdepappersöverföring in a depot export. Left
      // out on purpose, so no warning (unreadRows in parser.ts). A row cut
      // short before Belopp is still a warning: that may be a lost bank row.
      if (fields.length >= headers.length && (amountStr === '' || amountStr === '-')) continue
      // Avanza writes a decimal comma ("548,7", "-322400", "1 234,50"), so
      // the comma is the only decimal mark; "12abc" is null, never truncated.
      const amount = parseSwedishAmount(amountStr, ',')
      if (amount === null) {
        issues.push({ row: i + 1, message: `Ogiltigt belopp: ${amountStr ?? ''}`, severity: 'warning' })
        skippedRows++
        continue
      }

      const account = accountIdx >= 0 ? fields[accountIdx] : ''
      if (account) accounts.add(account)

      const type = typeIdx >= 0 ? fields[typeIdx] || '' : ''
      const text = textIdx >= 0 ? fields[textIdx] || '' : ''
      const currency = (currencyIdx >= 0 ? fields[currencyIdx] : '') || 'SEK'

      transactions.push({
        date,
        description: buildDescription(type, text),
        amount,
        currency: currency.toUpperCase(),
        balance: null,
        reference: null,
        counterparty: null,
        raw_line: line,
      })
    }

    if (accounts.size > 1) {
      issues.push({
        row: 0,
        message: `Filen innehåller flera Avanza-konton (${[...accounts].join(', ')}). En import bokförs mot ett bankkonto; exportera ett konto i taget.`,
        severity: 'error',
      })
    }

    return finishParseResult({
      format: 'avanza',
      format_name: 'Avanza',
      transactions,
      issues,
      totalRows: lines.length - 1,
      skippedRows,
    })
  },
}
