/**
 * Mynt card export parser (CSV or Excel)
 *
 * The report Mynt downloads under Bokföring & Export (Accounting & Export):
 * one row per card transaction on the company's Mynt account. Mynt lists the
 * fields of the export in its help center ("Export via Excel"): Transaction
 * date, Settlement date, Amount, Currency, Original amount, Original currency,
 * VAT amount, VAT rate, Reverse VAT, Description, Account, Category, Comment,
 * Filename, Settlement status, Person, Team, Card number, Card name,
 * Accounting status, Cost center, Project, Type, VAT code, Cost center ID and
 * Export date override. Older exports name the first column Date and have no
 * Settlement date or the columns after Accounting status.
 *
 * Format: the CSV is comma-delimited with a decimal point and YYYY-MM-DD
 * dates. The Excel file reaches this parser as semicolon text with a decimal
 * comma (../workbook.ts). The delimiter is sniffed from the header line and
 * the decimal mark is read from the amount cells themselves.
 *
 * Columns read:
 *   date          Transaction date (Date in older exports): the day of the
 *                 purchase; Settlement date only when it is empty
 *   amount        Amount, in Currency: the account's side, a purchase or fee
 *                 negative and a refund or top-up positive. The import
 *                 wizard's card sign check still decides per file.
 *   description   Description (the merchant), then Comment, then Original
 *                 amount and Original currency when the purchase was made in
 *                 another currency. A row with no Description (a top-up) is
 *                 named by its Category instead.
 *   counterparty  Description
 * Not read: the VAT and Account coding (a row is booked in Accounted with its
 * receipt), Filename (receipts arrive through the inbox), Settlement status,
 * Person, Team and the card columns.
 *
 * Notes:
 * - Quoted fields may hold the delimiter or a line break (a Comment), so the
 *   rows are split as records, not lines, and a cell's line breaks become
 *   spaces.
 * - A header row is looked for in the first lines, so a title row above it
 *   (an Excel heading) does not hide the export.
 */

import type { BankFileFormat, BankFileParseIssue, BankFileParseResult, ParsedBankTransaction } from '../types'
import { prepareContent } from '../../shared/encoding'
import { normalizeDate } from '../date-utils'
import { emptyParseResult, headerLikeCells, normalizeHeader, sniffDelimiter, splitCells, type ExpectedColumns } from '../columns'
import { splitCsvRecords } from '@/lib/csv-records'
import { inferDecimalMark, parseSwedishAmount, roundOre, sumOre } from '@/lib/money'
import { formatAmount, toSingleLine } from '@/lib/utils'

const FORMAT_ID = 'mynt' as const
const FORMAT_NAME = 'Mynt'

/** How many lines a title row may push the header down. */
const HEADER_SCAN_LINES = 10

const DATE_HEADERS = ['transaction date', 'date']
const SETTLEMENT_DATE_HEADER = 'settlement date'
/**
 * The columns that make a header Mynt's: every export, old and new, carries
 * them, and together they name no other bank's file.
 */
const REQUIRED_HEADERS = [
  'amount',
  'currency',
  'original amount',
  'original currency',
  'description',
  'settlement status',
  'card number',
]

export const MYNT_EXPECTED_COLUMNS: ExpectedColumns = {
  date: ['Transaction date', 'Date'],
  amount: ['Amount'],
  optional: ['Currency', 'Original amount', 'Original currency', 'Description', 'Comment', 'Settlement date'],
}

interface MyntColumns {
  date: number
  settlementDate: number
  amount: number
  currency: number
  originalAmount: number
  originalCurrency: number
  description: number
  comment: number
  category: number
}

interface MyntHeader {
  /** Index of the header among the file's non-empty lines. */
  lineIndex: number
  delimiter: string
  columns: MyntColumns
}

function columnsOf(cells: string[]): MyntColumns | null {
  const headers = cells.map(normalizeHeader)
  if (!REQUIRED_HEADERS.every((name) => headers.includes(name))) return null
  const date = DATE_HEADERS.map((name) => headers.indexOf(name)).find((index) => index !== -1)
  if (date === undefined) return null
  return {
    date,
    settlementDate: headers.indexOf(SETTLEMENT_DATE_HEADER),
    amount: headers.indexOf('amount'),
    currency: headers.indexOf('currency'),
    originalAmount: headers.indexOf('original amount'),
    originalCurrency: headers.indexOf('original currency'),
    description: headers.indexOf('description'),
    comment: headers.indexOf('comment'),
    category: headers.indexOf('category'),
  }
}

function findHeader(lines: string[]): MyntHeader | null {
  for (let lineIndex = 0; lineIndex < Math.min(lines.length, HEADER_SCAN_LINES); lineIndex++) {
    const delimiter = sniffDelimiter(lines[lineIndex])
    const columns = columnsOf(splitCells(lines[lineIndex], delimiter))
    if (columns) return { lineIndex, delimiter, columns }
  }
  return null
}

function nonEmptyLines(content: string): string[] {
  return prepareContent(content).split('\n').filter((line) => line.trim() !== '')
}

/** The date part of a cell: an Excel copy may carry a time after the day. */
function myntDate(cell: string | undefined): string | null {
  const day = (cell ?? '').trim().split(/[ T]/)[0]
  return normalizeDate(day)
}

const CURRENCY = /^[A-Z]{3}$/

export const myntFormat: BankFileFormat = {
  id: FORMAT_ID,
  name: FORMAT_NAME,
  description: 'Mynt card export, CSV or Excel (Bokföring & Export report)',
  fileExtensions: ['.csv', '.xls', '.xlsx'],

  detect(content: string, _filename: string): boolean {
    return findHeader(nonEmptyLines(content)) !== null
  },

  parse(content: string): BankFileParseResult {
    const lines = nonEmptyLines(content)
    const header = findHeader(lines)
    if (!header) {
      return emptyParseResult(
        FORMAT_ID,
        FORMAT_NAME,
        { row: 1, message: 'Kunde inte hitta Mynts kolumner (Transaction date, Amount, Currency, Description)', severity: 'error' },
        { found: headerLikeCells(prepareContent(content)), expected: MYNT_EXPECTED_COLUMNS },
      )
    }

    const { columns, delimiter } = header
    const { records, unterminated } = splitCsvRecords(lines.slice(header.lineIndex).join('\n'), delimiter)
    if (unterminated) {
      // The file stops inside a quoted field: the download was cut, and the
      // rows after the cut are not in it. Importing the rest would leave a
      // hole nobody sees.
      return emptyParseResult(FORMAT_ID, FORMAT_NAME, {
        row: 0,
        message: 'Filen slutar mitt i ett fält, så nedladdningen från Mynt blev avbruten. Inget importerades. Ladda ner rapporten igen.',
        severity: 'error',
      })
    }

    // A cell may hold a line break (a Comment): a bank row's text is one line.
    const dataRows = records.slice(1).map((record) => record.map(toSingleLine))
    const at = (row: string[], index: number) => (index >= 0 ? row[index] ?? '' : '')
    // One decimal mark for the file, read from its amount cells. A CSV that
    // proves none (whole amounts only) writes a point, the Excel text a comma.
    const decimalMark =
      inferDecimalMark(dataRows.flatMap((row) => [at(row, columns.amount), at(row, columns.originalAmount)])) ??
      (delimiter === ',' ? '.' : ',')

    const transactions: ParsedBankTransaction[] = []
    const issues: BankFileParseIssue[] = []
    let skippedRows = 0

    dataRows.forEach((row, index) => {
      // Numbered as the file's lines: any title rows, the header, then the data.
      const rowNumber = header.lineIndex + index + 2
      const dateCell = at(row, columns.date) || at(row, columns.settlementDate)
      const date = myntDate(dateCell)
      const amountCell = at(row, columns.amount)
      const amount = parseSwedishAmount(amountCell, decimalMark)
      const currency = at(row, columns.currency).toUpperCase()

      if (!date) {
        issues.push({ row: rowNumber, message: `Ogiltigt datum: ${dateCell}`, severity: 'warning' })
        skippedRows++
        return
      }
      if (amount === null) {
        issues.push({ row: rowNumber, message: `Ogiltigt belopp: ${amountCell}`, severity: 'warning' })
        skippedRows++
        return
      }
      if (!CURRENCY.test(currency)) {
        issues.push({ row: rowNumber, message: `Saknar valuta: ${at(row, columns.currency)}`, severity: 'warning' })
        skippedRows++
        return
      }
      if (amount === 0) {
        // Nothing moved on the account: left out on purpose, not unread.
        issues.push({ row: rowNumber, message: 'Belopp 0, hoppas över', severity: 'info' })
        skippedRows++
        return
      }

      const merchant = at(row, columns.description)
      const comment = at(row, columns.comment)
      const parts = [merchant || at(row, columns.category) || FORMAT_NAME]
      if (comment && !parts[0].includes(comment)) parts.push(comment)
      const originalCurrency = at(row, columns.originalCurrency).toUpperCase()
      const originalAmount = parseSwedishAmount(at(row, columns.originalAmount), decimalMark)
      if (CURRENCY.test(originalCurrency) && originalCurrency !== currency && originalAmount) {
        // formatAmount groups thousands with a no-break space: plain text here.
        parts.push(`${toSingleLine(formatAmount(Math.abs(originalAmount)))} ${originalCurrency}`)
      }

      transactions.push({
        date,
        description: parts.join(' - '),
        amount: roundOre(amount),
        currency,
        balance: null,
        reference: null,
        counterparty: merchant || null,
        raw_line: row.join(delimiter),
      })
    })

    const dates = transactions.map((transaction) => transaction.date).sort()
    return {
      format: FORMAT_ID,
      format_name: FORMAT_NAME,
      transactions,
      date_from: dates[0] || null,
      date_to: dates[dates.length - 1] || null,
      issues,
      stats: {
        total_rows: dataRows.length,
        parsed_rows: transactions.length,
        skipped_rows: skippedRows,
        total_income: sumOre(transactions.filter((t) => t.amount > 0).map((t) => t.amount)),
        total_expenses: sumOre(transactions.filter((t) => t.amount < 0).map((t) => t.amount)),
      },
    }
  },
}
