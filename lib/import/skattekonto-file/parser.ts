/**
 * Skattekontoutdrag parser (Skatteverket tax account statement export).
 *
 * Primary layout: the CSV download from Skatteverket's skattekonto e-service
 * (verified against a real 2026-08 export). Semicolon-delimited, every cell
 * double-quoted, UTF-8 with BOM, CRLF:
 *
 *   "Company AB";"NNNNNN-NNNN";""
 *   "";"";""
 *   "";"Ingående saldo YYYY-MM-DD";"-626"
 *   "YYYY-MM-DD";"Kostnadsränta";"-11"
 *   "YYYY-MM-DD";"Inbetalning bokförd 260710";"24 678"
 *   "";"Utgående saldo YYYY-MM-DD";"35 842"
 *
 * Three columns, no per-row running balance: the opening/closing saldo live
 * in marker rows with an empty date cell. Amounts are whole kronor with a
 * space thousands separator, negative = debit on the tax account (matches
 * belopp_skatteverket in skattekonto_transactions).
 *
 * Secondary tolerance: legacy `.skv` text exports from the retired
 * e-service. Same date;text;amount row shape but possibly unquoted, without
 * the name/orgnr header, and sometimes with a trailing running-saldo column,
 * which is ignored.
 */

import { roundOre } from '@/lib/money'
import { prepareContent } from '../shared/encoding'
import { normalizeDate } from '../bank-file/date-utils'
import { parseCSVLine } from '../bank-file/formats/nordea'
import type {
  ParsedSkattekontoFileRow,
  SkattekontoFileParseIssue,
  SkattekontoFileParseResult,
} from './types'

const ORG_NUMBER_RE = /^\d{6}-\d{4}$/
const OPENING_MARKER_RE = /^ing(å|a)ende saldo/i
const CLOSING_MARKER_RE = /^utg(å|a)ende saldo/i
/** Skatteverket's export filename: "Kontoutdrag 559538-6219 2026-05-03--2026-08-01.csv" */
const EXPORT_FILENAME_RE = /kontoutdrag \d{6}-\d{4} \d{4}-\d{2}-\d{2}--\d{4}-\d{2}-\d{2}/i

/**
 * Vocabulary characteristic of skattekonto statements. Terms that also occur
 * in bank statement descriptions (a payment TO Skatteverket can say "moms" or
 * "arbetsgivaravgift") are deliberately excluded from being sufficient alone:
 * legacy detection requires at least two DISTINCT hits plus the row shape.
 */
const SKV_VOCABULARY = [
  'ingående saldo',
  'utgående saldo',
  'debiterad preliminärskatt',
  'avdragen skatt',
  'intäktsränta',
  'kostnadsränta',
  'inbetalning bokförd',
]

/**
 * Parse a skattekonto amount: whole kronor or comma decimals, space/nbsp
 * thousands separators, optional trailing "kr". Returns null on non-amounts.
 */
function parseAmount(value: string): number | null {
  const cleaned = value
    // \s covers regular space, nbsp (U+00A0) and narrow nbsp (U+202F).
    .replace(/\s/g, '')
    .replace(/kr$/i, '')
    .replace(',', '.')
  if (cleaned === '' || cleaned === '-') return null
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null
  return roundOre(parseFloat(cleaned))
}

function splitRow(line: string): string[] {
  return parseCSVLine(line, ';').map((cell) => cell.trim())
}

function isEmptyRow(cells: string[]): boolean {
  return cells.every((cell) => cell === '')
}

/**
 * Detect whether a file is a skattekontoutdrag. Deliberately strict: this
 * runs inside the bank-file parse route as a redirect hint, so it must never
 * claim a bank CSV.
 */
export function detectSkattekontoFile(content: string, filename: string): boolean {
  if (/\.skv$/i.test(filename) || EXPORT_FILENAME_RE.test(filename)) return true

  const prepared = prepareContent(content)
  const lines = prepared.split('\n').filter((line) => line.trim() !== '')
  if (lines.length === 0) return false

  // Modern export: orgnr in the header row plus a saldo marker row.
  const firstCells = splitRow(lines[0])
  const hasOrgHeader = firstCells.length >= 2 && ORG_NUMBER_RE.test(firstCells[1])
  const hasMarker = lines.some((line) => {
    const cells = splitRow(line)
    const text = cells[1] ?? ''
    return OPENING_MARKER_RE.test(text) || CLOSING_MARKER_RE.test(text)
  })
  if (hasOrgHeader && hasMarker) return true

  // Legacy headerless files: at least two DISTINCT skattekonto terms plus a
  // dominant date;text;amount row shape. A bank CSV mentioning "moms" in one
  // description fails the two-term requirement; a bank export's header row
  // and extra columns fail the shape requirement.
  const lower = prepared.toLowerCase()
  const distinctTerms = SKV_VOCABULARY.filter((term) => lower.includes(term)).length
  if (!hasMarker && distinctTerms < 2) return false

  let shapeMatches = 0
  for (const line of lines) {
    const cells = splitRow(line)
    if (cells.length < 3) continue
    if (normalizeDate(cells[0]) && cells[1] !== '' && parseAmount(cells[2]) !== null) {
      shapeMatches++
    }
  }
  return shapeMatches >= 3 && shapeMatches / lines.length >= 0.6
}

/**
 * Parse a skattekontoutdrag into transaction rows plus the statement's
 * opening/closing saldo. Marker and header rows are consumed as metadata,
 * never emitted as transactions.
 */
export function parseSkattekontoFile(
  content: string,
  filename: string,
): SkattekontoFileParseResult {
  const variant: 'csv' | 'skv' = /\.skv$/i.test(filename) ? 'skv' : 'csv'
  const prepared = prepareContent(content)
  const lines = prepared.split('\n')

  const rows: ParsedSkattekontoFileRow[] = []
  const issues: SkattekontoFileParseIssue[] = []
  let companyName: string | null = null
  let orgNumber: string | null = null
  let openingSaldo: number | null = null
  let closingSaldo: number | null = null
  let sawSaldoMarker = false
  let totalRows = 0
  let skippedRows = 0

  const seenContent = new Map<string, number>()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const cells = splitRow(line)
    if (isEmptyRow(cells)) continue

    // Header row: "Company AB";"NNNNNN-NNNN";""
    if (orgNumber === null && cells.length >= 2 && ORG_NUMBER_RE.test(cells[1])) {
      companyName = cells[0] || null
      orgNumber = cells[1]
      continue
    }

    // Marker rows: "Ingående/Utgående saldo YYYY-MM-DD" in the text cell.
    // The modern export leaves the date cell empty; tolerate legacy variants
    // that date the marker row. Never import a marker as a transaction.
    const markerText = cells[1] ?? ''
    if (OPENING_MARKER_RE.test(markerText) || CLOSING_MARKER_RE.test(markerText)) {
      sawSaldoMarker = true
      const amount = parseAmount(cells[2] ?? '')
      if (amount === null) {
        issues.push({
          row: i + 1,
          message: `Kunde inte läsa saldobeloppet: ${cells[2] ?? ''}`,
          severity: 'warning',
        })
      } else if (OPENING_MARKER_RE.test(markerText)) {
        openingSaldo = amount
      } else {
        closingSaldo = amount
      }
      continue
    }

    totalRows++

    const date = normalizeDate(cells[0] ?? '')
    if (!date) {
      issues.push({
        row: i + 1,
        message: `Ogiltigt datum: ${cells[0] ?? ''}`,
        severity: 'warning',
      })
      skippedRows++
      continue
    }

    const text = cells[1] ?? ''
    if (text === '') {
      issues.push({ row: i + 1, message: 'Transaktionstext saknas', severity: 'warning' })
      skippedRows++
      continue
    }

    const belopp = parseAmount(cells[2] ?? '')
    if (belopp === null) {
      issues.push({
        row: i + 1,
        message: `Ogiltigt belopp: ${cells[2] ?? ''}`,
        severity: 'warning',
      })
      skippedRows++
      continue
    }

    const signature = `${date}|${belopp}|${text}`
    const occurrence = (seenContent.get(signature) ?? 0) + 1
    seenContent.set(signature, occurrence)
    if (occurrence === 2) {
      issues.push({
        row: i + 1,
        message: `Identiska rader i filen (${text} ${date}): båda importeras`,
        severity: 'info',
      })
    }

    rows.push({ transaktionsdatum: date, transaktionstext: text, belopp, raw_line: line })
  }

  // Integrity: the statement must sum. A mismatch means a truncated or
  // hand-edited file: surfaced as an error so the route refuses the import.
  // A file that HAS saldo markers but not both valid balances is equally
  // suspect (cut off before "Utgående saldo", or a garbled amount): fail it
  // rather than silently skipping the check. Only marker-less legacy files
  // legitimately have no balances to check (sum_valid stays null).
  let sumValid: boolean | null = null
  if (openingSaldo !== null && closingSaldo !== null) {
    const sum = rows.reduce((acc, row) => roundOre(acc + row.belopp), openingSaldo)
    sumValid = Math.abs(sum - closingSaldo) < 0.005
    if (!sumValid) {
      issues.push({
        row: 0,
        message: `Ingående saldo plus transaktioner (${sum}) stämmer inte med utgående saldo (${closingSaldo})`,
        severity: 'error',
      })
    }
  } else if (sawSaldoMarker) {
    sumValid = false
    issues.push({
      row: 0,
      message:
        'Utdraget saknar ett läsbart ingående eller utgående saldo. Filen kan vara ofullständig; ladda ner den på nytt från Skatteverket.',
      severity: 'error',
    })
  }

  const dates = rows.map((row) => row.transaktionsdatum).sort()

  return {
    variant,
    company_name: companyName,
    org_number: orgNumber,
    rows,
    date_from: dates[0] ?? null,
    date_to: dates[dates.length - 1] ?? null,
    opening_saldo: openingSaldo,
    closing_saldo: closingSaldo,
    sum_valid: sumValid,
    issues,
    stats: {
      total_rows: totalRows,
      parsed_rows: rows.length,
      skipped_rows: skippedRows,
    },
  }
}
