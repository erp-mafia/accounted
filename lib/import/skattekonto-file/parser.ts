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
 * which is ignored for event rows (a marker row whose belopp cell is empty
 * takes its saldo from that column instead). Several marker pairs (one per
 * year or page) are reduced to the earliest opening and latest closing.
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
 * thousands separators, optional trailing "kr", optional explicit "+".
 * Typographic minus variants (U+2212 MINUS SIGN, the CLDR sv-SE default,
 * plus hyphen/dash lookalikes) count as a minus. Returns null on non-amounts.
 */
function parseAmount(value: string): number | null {
  const cleaned = value
    // \s covers regular space, nbsp (U+00A0) and narrow nbsp (U+202F).
    .replace(/\s/g, '')
    .replace(/kr$/i, '')
    // U+2212 minus sign, U+2010..U+2013 hyphen/dash lookalikes.
    .replace(/^[\u2212\u2010-\u2013]/, '-')
    .replace(/^\+/, '')
    .replace(',', '.')
  if (cleaned === '' || cleaned === '-') return null
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null
  return roundOre(parseFloat(cleaned))
}

/**
 * Amount of a saldo marker row. The Kontoutdrag export puts it in the
 * belopp column; a layout with a trailing running-saldo column leaves belopp
 * empty and carries the saldo in the last column. Take the last readable
 * amount at or after the belopp column.
 */
function parseMarkerAmount(cells: string[]): number | null {
  for (let i = cells.length - 1; i >= 2; i--) {
    const amount = parseAmount(cells[i])
    if (amount !== null) return amount
  }
  return null
}

/** Date written into a marker text ("Ingående saldo 2026-05-03"), if any. */
function markerDate(text: string, dateCell: string): string | null {
  const inText = /(\d{4}-\d{2}-\d{2})/.exec(text)
  return (inText ? normalizeDate(inText[1]) : null) ?? normalizeDate(dateCell)
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
  // A statement can carry several marker pairs (one per year or per page).
  // The statement-level check runs from the earliest opening to the latest
  // closing; intermediate pairs cancel out. Order by the marker's own date,
  // falling back to file order for undated markers.
  let opening: { saldo: number; date: string | null; seq: number } | null = null
  let closing: { saldo: number; date: string | null; seq: number } | null = null
  let sawSaldoMarker = false
  let markerSeq = 0
  let totalRows = 0
  let skippedRows = 0
  let unreadableAmountRows = 0

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
      const amount = parseMarkerAmount(cells)
      if (amount === null) {
        issues.push({
          row: i + 1,
          message: `Kunde inte läsa saldobeloppet: ${cells[2] ?? ''}`,
          severity: 'warning',
        })
        continue
      }
      const marker = { saldo: amount, date: markerDate(markerText, cells[0] ?? ''), seq: markerSeq++ }
      if (OPENING_MARKER_RE.test(markerText)) {
        if (!opening || isEarlierMarker(marker, opening)) opening = marker
      } else if (!closing || isEarlierMarker(closing, marker)) {
        closing = marker
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
      // A dated event we could not read is money missing from the sum check.
      unreadableAmountRows++
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

  // Integrity: a complete statement sums (opening + events = closing). A
  // mismatch means a truncated, filtered or hand-edited file, or dated rows
  // whose amount we could not read. It is reported as an error-severity
  // issue with the figures; the import route no longer refuses the file on
  // it (the preview shows the gap and asks the user to confirm), because
  // every parsed row is still a real event that is reviewed before booking
  // and re-importing a complete file later dedups. A file that HAS saldo
  // markers but not both readable balances is flagged the same way. Only
  // marker-less legacy files legitimately have nothing to check
  // (sum_valid stays null).
  const openingSaldo = opening?.saldo ?? null
  const closingSaldo = closing?.saldo ?? null
  let sumValid: boolean | null = null
  let eventsSum: number | null = null
  let sumDifference: number | null = null
  if (openingSaldo !== null && closingSaldo !== null) {
    eventsSum = rows.reduce((acc, row) => roundOre(acc + row.belopp), openingSaldo)
    sumDifference = roundOre(closingSaldo - eventsSum)
    sumValid = Math.abs(sumDifference) < 0.005
    if (!sumValid) {
      issues.push({
        row: 0,
        message:
          unreadableAmountRows > 0
            ? `Ingående saldo plus händelser (${eventsSum}) stämmer inte med utgående saldo (${closingSaldo}); ${unreadableAmountRows} rader med oläsbart belopp saknas i summan`
            : `Ingående saldo plus händelser (${eventsSum}) stämmer inte med utgående saldo (${closingSaldo}); differens ${sumDifference}`,
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
    events_sum: eventsSum,
    sum_difference: sumDifference,
    issues,
    stats: {
      total_rows: totalRows,
      parsed_rows: rows.length,
      skipped_rows: skippedRows,
      unreadable_amount_rows: unreadableAmountRows,
    },
  }
}

/** Earlier by marker date when both are dated; otherwise by file order. */
function isEarlierMarker(
  a: { date: string | null; seq: number },
  b: { date: string | null; seq: number },
): boolean {
  if (a.date && b.date && a.date !== b.date) return a.date < b.date
  return a.seq < b.seq
}
