/**
 * Column helpers for bank files whose shape varies: the delimiter a line uses,
 * a header label in comparable form, and, when nothing in a file is
 * recognized, which columns it does have so the error can name them.
 */

import { parseCSVLine } from './formats/nordea'
import type { BankFileFormatId, BankFileParseIssue, BankFileParseResult } from './types'

const DELIMITERS = [';', '\t', ','] as const

/**
 * The delimiter a line uses: the one with the most occurrences outside
 * quotes, semicolon first on a tie. Swedish bank exports and a Swedish Excel
 * "save as CSV" use semicolons; an English-locale spreadsheet uses commas.
 */
export function sniffDelimiter(line: string): string {
  const counts: Record<string, number> = { ';': 0, '\t': 0, ',': 0 }
  let inQuotes = false
  for (const char of line) {
    if (char === '"') inQuotes = !inQuotes
    else if (!inQuotes && char in counts) counts[char]++
  }
  let best: string = ';'
  for (const d of DELIMITERS) if (counts[d] > counts[best]) best = d
  return best
}

/** A line's cells, trimmed and unquoted. */
export function splitCells(line: string, delimiter: string): string[] {
  return parseCSVLine(line, delimiter).map((cell) => cell.trim().replace(/^"|"$/g, '').trim())
}

/**
 * A header label in comparable form: lower case, no diacritics (an
 * un-decoded "Bokforingsdag" reads like "Bokföringsdag"), single spaces, no
 * BOM, quotes or trailing colon.
 */
export function normalizeHeader(label: string): string {
  return label
    .replace(/^﻿/, '')
    .replace(/"/g, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/:$/, '')
    .trim()
}

const DATE_LIKE = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/
const NUMBER_LIKE = /^[-+−(]?[\d\s .,]+\)?$/

/** A cell that reads as a label: has a letter and is not a date or an amount. */
function isLabel(cell: string): boolean {
  return /\p{L}/u.test(cell) && !DATE_LIKE.test(cell) && !NUMBER_LIKE.test(cell)
}

const MAX_REPORTED_COLUMNS = 15
const MAX_LABEL_LENGTH = 40

/**
 * The file's most header-like row among its first lines: the one with the
 * most label cells. Empty when no line has two labels (no header row at all).
 */
export function headerLikeCells(content: string, scanLines = 20): string[] {
  const lines = content
    .replace(/^﻿/, '')
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim() !== '')
    .slice(0, scanLines)

  let best: string[] = []
  let bestLabels = 1
  for (const line of lines) {
    const cells = splitCells(line, sniffDelimiter(line)).filter((cell) => cell !== '')
    const labels = cells.filter(isLabel).length
    if (labels > bestLabels) {
      best = cells
      bestLabels = labels
    }
  }
  return best
    .slice(0, MAX_REPORTED_COLUMNS)
    .map((cell) => (cell.length > MAX_LABEL_LENGTH ? `${cell.slice(0, MAX_LABEL_LENGTH)}…` : cell))
}

/** The columns a format reads: the date and amount it needs, the rest it uses when present. */
export interface ExpectedColumns {
  date: string[]
  amount: string[]
  optional: string[]
}

/** What a file's columns were against what the format reads (BANK_FILE_COLUMNS_UNRECOGNIZED). */
export interface UnrecognizedColumns {
  found: string[]
  expected: ExpectedColumns
}

function orList(items: string[], or: string): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} ${or} ${items[items.length - 1]}`
}

/** The Swedish and English sentences naming the columns found and the ones expected. */
export function unrecognizedColumnsMessages(
  formatName: string,
  columns: UnrecognizedColumns,
): { sv: string; en: string } {
  const { found, expected } = columns
  const optionalSv = expected.optional.length > 0 ? ` ${orList(expected.optional, 'och')} läses om de finns.` : ''
  const optionalEn = expected.optional.length > 0 ? ` ${orList(expected.optional, 'and')} are read when present.` : ''
  return {
    sv:
      `Filens kolumner kändes inte igen som en export från ${formatName}. ` +
      `Kolumner i filen: ${found.length > 0 ? found.join(', ') : 'ingen rubrikrad hittades'}. ` +
      `Filen behöver en datumkolumn (${orList(expected.date, 'eller')}) ` +
      `och en beloppskolumn (${orList(expected.amount, 'eller')}).${optionalSv}`,
    en:
      `The file's columns were not recognized as a ${formatName} export. ` +
      `Columns found: ${found.length > 0 ? found.join(', ') : 'no header row found'}. ` +
      `The file needs a date column (${orList(expected.date, 'or')}) ` +
      `and an amount column (${orList(expected.amount, 'or')}).${optionalEn}`,
  }
}

/** A parse that read no row: the issue that says why, and the file's columns when none was recognized. */
export function emptyParseResult(
  format: BankFileFormatId,
  formatName: string,
  issue: BankFileParseIssue,
  columns?: UnrecognizedColumns,
): BankFileParseResult {
  return {
    format,
    format_name: formatName,
    transactions: [],
    date_from: null,
    date_to: null,
    issues: [issue],
    ...(columns ? { unrecognized_columns: columns } : {}),
    stats: { total_rows: 0, parsed_rows: 0, skipped_rows: 0, total_income: 0, total_expenses: 0 },
  }
}
