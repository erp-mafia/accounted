/**
 * Länsförsäkringar bank file parser
 *
 * Länsförsäkringar's internet bank exports account history in more than one
 * shape (crm#1236), so this parser reads columns by NAME wherever the file has
 * a header row, and by position only when it has none:
 *
 * - The transaction list as CSV: semicolon-delimited, quoted fields, decimal
 *   comma, sometimes an account block above the column header.
 * - The kontoutdrag as one Excel file per month, with the month as a heading
 *   row above the column header. The upload turns a workbook into semicolon
 *   text first (../workbook.ts), so this parser always reads text.
 * - That Excel file saved again as CSV by the customer: semicolon or comma
 *   separated depending on the spreadsheet's language, quoted or not, with or
 *   without a BOM and the heading row, whole amounts written without decimals.
 *
 * Columns, by name (case, quotes and diacritics ignored):
 *   date         Bokföringsdag / Bokföringsdatum, else Datum, else
 *                Transaktionsdag / Transaktionsdatum
 *   description  Text / Meddelande / Beskrivning, else the Typ column
 *   amount       Belopp, or Insättning(ar) and Uttag
 *   balance      Saldo
 * Amounts: decimal comma or point, spaces or non-breaking spaces between
 * thousands, minus as a hyphen, a Unicode minus, trailing or in parentheses.
 * Dates: YYYY-MM-DD, YYYY/MM/DD, DD.MM.YYYY, DD/MM/YYYY (MM/DD/YYYY when the
 * file's own dates show the month comes first), a trailing time ignored.
 *
 * Of the two dates on a row we emit the BOOKING date, not the transaction
 * date. The two differ on card purchases (swiped the 14th, booked the 16th)
 * and the emitted date is not cosmetic: it feeds generateExternalId and the
 * exact-date content-dedup bucket (contentBucketKey). The PSD2 / Enable
 * Banking feed for the same account keys every row on the ASPSP's
 * booking_date and cannot be moved off it (Berlin Group exposes no stable
 * transaction date, and the value_date path caused the June 2026 fleet-wide
 * re-import; see extensions/general/enable-banking/lib/sync.ts). A row dated
 * on the transaction date therefore lands in a different bucket than the feed
 * row for the same affärshändelse, no dedup layer looks across days, and both
 * rows insert as duplicates. Booking date is also what the Saldo column ties
 * to. A header-less file names neither column, so there the booking date is
 * the column whose dates are the later ones: a purchase is never booked
 * before it is made. Header-ful and header-less exports of the same account
 * thereby resolve to the same date, and the two upload paths cannot
 * duplicate each other.
 */

import type { BankFileFormat, BankFileParseResult, ParsedBankTransaction, BankFileParseIssue } from '../types'
import { prepareContent } from '../../shared/encoding'
import { preambleAccountIdentity } from '../account-identity'
import { normalizeDate } from '../date-utils'
import {
  emptyParseResult,
  headerLikeCells,
  normalizeHeader,
  sniffDelimiter,
  splitCells,
  unrecognizedColumnsMessages,
  type ExpectedColumns,
} from '../columns'
import { parseSwedishAmount, roundOre } from '@/lib/money'

const FORMAT_ID = 'lansforsakringar' as const
const FORMAT_NAME = 'Länsförsäkringar'

/** How far down the column header may sit: a month heading, an account block. */
const HEADER_SCAN_LIMIT = 30
/** How many leading rows recognize a header-less file in detect(). */
const HEADERLESS_DETECT_ROWS = 3

/** The columns this parser reads, for the error when it finds none of them. */
export const LANSFORSAKRINGAR_EXPECTED_COLUMNS: ExpectedColumns = {
  date: ['Bokföringsdag', 'Bokföringsdatum', 'Transaktionsdatum', 'Datum'],
  amount: ['Belopp', 'Insättning + Uttag'],
  optional: ['Text', 'Meddelande', 'Saldo'],
}

// Header labels after normalizeHeader (lower case, no diacritics).
const BOOKING_DATE_RE = /^(bokforingsda(g|tum)|bokford)$/
const PLAIN_DATE_RE = /^datum$/
const TRANSACTION_DATE_RE = /^transaktionsda(g|tum)$/
/** Description columns in order of preference. */
const TEXT_LABELS = ['text', 'meddelande', 'beskrivning', 'transaktionstext', 'specifikation']
const TYPE_RE = /^(transaktions)?typ$/
const AMOUNT_RE = /^belopp( ?\(?(sek|kr)\)?)?$/
const DEPOSIT_RE = /^insattning(ar)?$/
const WITHDRAWAL_RE = /^uttag$/
const BALANCE_RE = /^(bokfort )?saldo( ?\(?(sek|kr)\)?)?$/
/** Columns of other banks' exports; a header carrying one is not Länsförsäkringar's. */
const OTHER_BANK_RE =
  /^(valuta(dag|datum)|clearingnummer|clnr|radnummer|radnr|reskontradatum|verifikationsnummer|bankkategori)$/

interface LFColumns {
  date: number
  /** The date column is a booking date by name. */
  bookingDate: boolean
  /** How many date columns the header names (booking, plain, transaction). */
  dateColumns: number
  text: number
  type: number
  amount: number
  deposit: number
  withdrawal: number
  balance: number
  otherBank: boolean
}

/** The columns a header row names, or null when it is not a usable header. */
function readHeader(cells: string[]): LFColumns | null {
  const labels = cells.map(normalizeHeader)
  const find = (re: RegExp) => labels.findIndex((label) => re.test(label))

  const booking = find(BOOKING_DATE_RE)
  const plain = find(PLAIN_DATE_RE)
  const transaction = find(TRANSACTION_DATE_RE)
  // Bokföringsdag first; Datum before Transaktionsdatum, since an export with
  // a plain Datum beside a transaction date uses Datum as its booking date.
  const date = booking >= 0 ? booking : plain >= 0 ? plain : transaction
  const amount = find(AMOUNT_RE)
  const deposit = find(DEPOSIT_RE)
  const withdrawal = find(WITHDRAWAL_RE)
  if (date < 0) return null
  if (amount < 0 && (deposit < 0 || withdrawal < 0)) return null

  const text = TEXT_LABELS.map((name) => labels.indexOf(name)).find((index) => index >= 0) ?? -1
  return {
    date,
    bookingDate: booking >= 0,
    dateColumns: [booking, plain, transaction].filter((index) => index >= 0).length,
    text,
    type: find(TYPE_RE),
    amount,
    deposit,
    withdrawal,
    balance: find(BALANCE_RE),
    otherBank: labels.some((label) => OTHER_BANK_RE.test(label)),
  }
}

/**
 * The first header row within the scan limit, with the delimiter its line
 * uses. Rows above it (a month heading, an account block) are not data.
 */
function findHeader(lines: string[]): { index: number; delimiter: string; columns: LFColumns } | null {
  for (let i = 0; i < Math.min(lines.length, HEADER_SCAN_LIMIT); i++) {
    const delimiter = sniffDelimiter(lines[i])
    const columns = readHeader(splitCells(lines[i], delimiter))
    if (columns) return { index: i, delimiter, columns }
  }
  return null
}

/**
 * The original Länsförsäkringar header test, kept for the first line as it
 * always was: semicolons and the words datum, typ and belopp.
 */
function isLegacyHeaderLine(line: string): boolean {
  const lower = line.toLowerCase().replace(/"/g, '')
  return lower.includes(';') && lower.includes('datum') && lower.includes('typ') && lower.includes('belopp')
}

/** A date cell, optionally followed by a time the export added. */
function cleanDate(raw: string | undefined): string {
  return (raw ?? '').trim().replace(/[ T]\d{1,2}:\d{2}(:\d{2})?$/, '')
}

const DATE_SHAPE_RE = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/
const AMOUNT_SHAPE_RE = /^[-+−(]?[\d\s .,]*\d[\d\s .,]*\)?[-−]?$/

function isDateCell(raw: string | undefined): boolean {
  const value = cleanDate(raw)
  return DATE_SHAPE_RE.test(value) && normalizeDate(value) !== null
}

/**
 * An amount as Länsförsäkringar, or a spreadsheet that re-saved its file,
 * writes it: "-1 234,56", "1234.5", "-500", "(1 234,56)", "1 234,56-",
 * "−99,00 kr". Null when the cell is empty or not an amount.
 */
export function parseLansforsakringarAmount(raw: string | undefined): number | null {
  let text = (raw ?? '').trim().replace(/\s*(kr|sek)$/i, '')
  if (!text) return null
  let negative = false
  const parenthesized = /^\((.*)\)$/.exec(text)
  if (parenthesized) {
    negative = true
    text = parenthesized[1].trim()
  }
  const trailingMinus = /^(.*\d)\s*[-−]$/.exec(text)
  if (trailingMinus) {
    negative = true
    text = trailingMinus[1]
  }
  const value = parseSwedishAmount(text)
  if (value === null) return null
  const signed = negative ? -Math.abs(value) : value
  return signed === 0 ? 0 : signed
}

/** A header-less Länsförsäkringar row: two dates first, an amount in the fifth column. */
function isHeaderlessRow(cells: string[]): boolean {
  return (
    cells.length >= 5 &&
    isDateCell(cells[0]) &&
    isDateCell(cells[1]) &&
    AMOUNT_SHAPE_RE.test(cells[4]) &&
    parseLansforsakringarAmount(cells[4]) !== null
  )
}

/**
 * Which of a header-less file's two leading date columns is the booking
 * date: the one whose dates are later where the two differ. Column 1 when
 * they never differ (then the dates are the same anyway).
 */
function headerlessBookingIndex(rows: string[][]): 0 | 1 {
  let firstLater = 0
  let secondLater = 0
  for (const cells of rows) {
    const first = normalizeDate(cleanDate(cells[0]))
    const second = normalizeDate(cleanDate(cells[1]))
    if (!first || !second || first === second) continue
    if (first > second) firstLater++
    else secondLater++
  }
  return firstLater > secondLater ? 0 : 1
}

/**
 * MM/DD/YYYY when the file's own slash dates show the month comes first (a
 * second part above 12, no first part above 12), as an English-language
 * spreadsheet writes them. Otherwise the Swedish DD/MM/YYYY.
 */
function slashDateHint(values: string[]): string | undefined {
  let dayFirst = false
  let monthFirst = false
  for (const value of values) {
    const match = /^(\d{1,2})\/(\d{1,2})\/\d{4}$/.exec(cleanDate(value))
    if (!match) continue
    if (Number(match[1]) > 12) dayFirst = true
    if (Number(match[2]) > 12) monthFirst = true
  }
  return monthFirst && !dayFirst ? 'MM/DD/YYYY' : undefined
}

/** A row that totals or carries a balance rather than recording a transaction. */
const SUMMARY_ROW_RE = /saldo|summa|totalt/i

interface RowLayout {
  date: number
  text: number
  type: number
  amount: number
  deposit: number
  withdrawal: number
  balance: number
}

function rowAmount(cells: string[], layout: RowLayout): { value: number | null; raw: string } {
  if (layout.amount >= 0) {
    const raw = cells[layout.amount] ?? ''
    return { value: parseLansforsakringarAmount(raw), raw }
  }
  const depositRaw = cells[layout.deposit] ?? ''
  const withdrawalRaw = cells[layout.withdrawal] ?? ''
  const deposit = parseLansforsakringarAmount(depositRaw)
  const withdrawal = parseLansforsakringarAmount(withdrawalRaw)
  const raw = [depositRaw, withdrawalRaw].filter((part) => part !== '').join(' / ')
  if (deposit === null && withdrawal === null) return { value: null, raw }
  return { value: roundOre(Math.abs(deposit ?? 0) - Math.abs(withdrawal ?? 0)), raw }
}

function emptyResult(issue: BankFileParseIssue, columns?: BankFileParseResult['unrecognized_columns']): BankFileParseResult {
  return emptyParseResult(FORMAT_ID, FORMAT_NAME, issue, columns)
}

export const lansforsakringarFormat: BankFileFormat = {
  id: FORMAT_ID,
  name: FORMAT_NAME,
  description: 'Länsförsäkringar CSV or Excel kontoutdrag (header by column name, or header-less rows)',
  fileExtensions: ['.csv', '.txt', '.xls', '.xlsx'],

  detect(content: string, _filename: string): boolean {
    const lines = prepareContent(content).split('\n').filter((line) => line.trim() !== '')
    if (lines.length === 0) return false

    if (isLegacyHeaderLine(lines[0])) return true

    // A header that names a booking date beside a second date column and an
    // amount, and nothing only another bank's export has. The formats that
    // can carry such a header (SEB, Swedbank, Handelsbanken) are checked
    // first and also step aside for it.
    const header = findHeader(lines)
    if (header) {
      const { columns } = header
      if (columns.bookingDate && columns.dateColumns >= 2 && !columns.otherBank) return true
    }

    return lines
      .slice(0, HEADERLESS_DETECT_ROWS)
      .some((line) => isHeaderlessRow(splitCells(line, sniffDelimiter(line))))
  },

  parse(content: string): BankFileParseResult {
    const prepared = prepareContent(content)
    const lines = prepared.split('\n').filter((line) => line.trim() !== '')

    let layout: RowLayout
    let delimiter: string
    let startIdx: number
    let account: BankFileParseResult['account'] = undefined

    const header = findHeader(lines)
    if (header) {
      const { columns } = header
      layout = {
        date: columns.date,
        text: columns.text,
        type: columns.type,
        amount: columns.amount,
        deposit: columns.deposit,
        withdrawal: columns.withdrawal,
        balance: columns.balance,
      }
      delimiter = header.delimiter
      startIdx = header.index + 1
      account = preambleAccountIdentity(lines, header.index)
    } else {
      // No header: the rows themselves must have the Länsförsäkringar shape,
      // Datum;Bokföringsdag (in some order);Typ;Text;Belopp;Saldo.
      const firstRow = lines
        .slice(0, HEADER_SCAN_LIMIT)
        .findIndex((line) => isHeaderlessRow(splitCells(line, sniffDelimiter(line))))
      if (firstRow === -1) {
        const columns = { found: headerLikeCells(prepared), expected: LANSFORSAKRINGAR_EXPECTED_COLUMNS }
        return emptyResult(
          { row: 0, message: unrecognizedColumnsMessages(FORMAT_NAME, columns).sv, severity: 'error' },
          columns,
        )
      }
      delimiter = sniffDelimiter(lines[firstRow])
      startIdx = firstRow
      const rows = lines.slice(firstRow).map((line) => splitCells(line, delimiter))
      layout = {
        date: headerlessBookingIndex(rows.filter(isHeaderlessRow)),
        text: 3,
        type: 2,
        amount: 4,
        deposit: -1,
        withdrawal: -1,
        balance: 5,
      }
    }

    const rows = lines.slice(startIdx).map((line) => ({ line: line.trim(), cells: splitCells(line, delimiter) }))
    const dateHint = slashDateHint(rows.map(({ cells }) => cells[layout.date] ?? ''))

    const transactions: ParsedBankTransaction[] = []
    const issues: BankFileParseIssue[] = []
    let skippedRows = 0

    rows.forEach(({ line, cells }, offset) => {
      const rowNumber = startIdx + offset + 1
      // Not transactions: an empty spreadsheet row, the header again (one
      // file holding several months), a heading or a balance line.
      if (cells.every((cell) => cell === '')) return
      if (readHeader(cells)) return

      const dateRaw = cleanDate(cells[layout.date])
      const amount = rowAmount(cells, layout)
      const date = normalizeDate(dateRaw, dateHint)
      const summary = SUMMARY_ROW_RE.test(cells.join(' '))

      if (!date) {
        if (amount.raw === '' || summary) return
        issues.push({
          row: rowNumber,
          message: dateRaw ? `Ogiltigt datum: ${dateRaw}` : 'Saknar datum',
          severity: 'warning',
        })
        skippedRows++
        return
      }
      if (amount.value === null) {
        if (amount.raw === '' && summary) return
        issues.push({
          row: rowNumber,
          message: amount.raw ? `Ogiltigt belopp: ${amount.raw}` : 'Saknar belopp',
          severity: 'warning',
        })
        skippedRows++
        return
      }

      const text = layout.text >= 0 ? cells[layout.text] : ''
      const type = layout.type >= 0 ? cells[layout.type] : ''
      const balanceRaw = layout.balance >= 0 ? cells[layout.balance] : undefined

      transactions.push({
        date,
        description: (text || type || 'Unknown').trim(),
        amount: amount.value,
        currency: 'SEK',
        balance: parseLansforsakringarAmount(balanceRaw),
        reference: null,
        counterparty: null,
        raw_line: line,
      })
    })

    const dates = transactions.map((t) => t.date).sort()

    return {
      format: FORMAT_ID,
      format_name: FORMAT_NAME,
      transactions,
      ...(account !== undefined ? { account } : {}),
      date_from: dates[0] || null,
      date_to: dates[dates.length - 1] || null,
      issues,
      stats: {
        total_rows: transactions.length + skippedRows,
        parsed_rows: transactions.length,
        skipped_rows: skippedRows,
        total_income: Math.round(transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0) * 100) / 100,
        total_expenses: Math.round(transactions.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0) * 100) / 100,
      },
    }
  },
}
