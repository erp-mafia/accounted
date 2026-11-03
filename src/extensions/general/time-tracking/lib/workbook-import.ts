import crypto from 'crypto'
import * as XLSX from 'xlsx'
import { MAX_HOURS_PER_ENTRY } from '../types'
import type { ActivityCode, Consultant } from '../types'

/**
 * Parser for time-report workbooks shaped like the Numbers "Projektredovisning"
 * template: a Transaktioner table (Datum, Dag, Medarb, Kund, Projekt, A-kod,
 * Timmar, Kommentar) plus register tables for Medarbetare, Kunder and
 * Arbetskoder. Tables are found by their header row, not by sheet name or
 * position: the Numbers export prepends filter rows and an empty column, and
 * a user who renames a sheet should not break the import.
 */

export interface ParsedTimeRow {
  /** 1-based row number in the source sheet, for error messages. */
  source_row: number
  entry_date: string
  consultant: string
  customer_code: string
  project_code: string | null
  activity_code: string | null
  hours: number
  comment: string | null
  import_key: string
}

export type SkipReason = 'invalid_date' | 'invalid_hours' | 'missing_consultant' | 'missing_customer'

export interface SkippedRow {
  source_row: number
  reason: SkipReason
  /** The cell that failed, as text, so the user can find it in the sheet. */
  value: string
}

export interface ParsedTimeWorkbook {
  consultants: Consultant[]
  activity_codes: ActivityCode[]
  customers: Array<{ code: string; name: string }>
  rows: ParsedTimeRow[]
  skipped: SkippedRow[]
}

export class TimeWorkbookError extends Error {
  constructor(public readonly code: 'NO_TRANSACTIONS_TABLE') {
    super(code)
  }
}

type Cell = string | number | boolean | Date | null

/** Lowercase, trim and drop punctuation so 'A-kod', 'A kod' and 'akod' match. */
function normalizeHeader(value: Cell): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9åäö]/g, '')
}

function cellText(value: Cell): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function optionalText(value: Cell): string | null {
  const text = cellText(value)
  return text === '' ? null : text
}

const TRANSACTION_COLUMNS = {
  date: ['datum'],
  consultant: ['medarb', 'medarbetare', 'medarbetarkod'],
  customer: ['kund', 'kundkod'],
  project: ['projekt', 'projektnummer'],
  activity: ['akod', 'arbetskod'],
  hours: ['timmar', 'tim'],
  comment: ['kommentar'],
} as const

type ColumnKey = keyof typeof TRANSACTION_COLUMNS

interface Table {
  header_row: number
  columns: Record<string, number>
  rows: Cell[][]
}

function sheetRows(sheet: XLSX.WorkSheet): Cell[][] {
  return XLSX.utils.sheet_to_json<Cell[]>(sheet, { header: 1, raw: true, defval: null })
}

/** Locate the first row containing every required header; map all known headers. */
function findTable(
  rows: Cell[][],
  spec: Record<string, readonly string[]>,
  required: string[],
): { header_row: number; columns: Record<string, number> } | null {
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const normalized = rows[r].map(normalizeHeader)
    const columns: Record<string, number> = {}
    for (const [key, aliases] of Object.entries(spec)) {
      const idx = normalized.findIndex((h) => aliases.includes(h))
      if (idx >= 0) columns[key] = idx
    }
    if (required.every((key) => key in columns)) return { header_row: r, columns }
  }
  return null
}

function findTableInWorkbook(
  workbook: XLSX.WorkBook,
  spec: Record<string, readonly string[]>,
  required: string[],
): Table | null {
  for (const name of workbook.SheetNames) {
    const rows = sheetRows(workbook.Sheets[name])
    const found = findTable(rows, spec, required)
    if (found) return { header_row: found.header_row, columns: found.columns, rows }
  }
  return null
}

/** Two-column register (code + name) such as Kunder or Medarbetare. */
function readRegister(
  workbook: XLSX.WorkBook,
  codeAliases: readonly string[],
  nameAliases: readonly string[],
): Array<{ code: string; name: string }> {
  const table = findTableInWorkbook(workbook, { code: codeAliases, name: nameAliases }, ['code', 'name'])
  if (!table) return []
  const seen = new Set<string>()
  const out: Array<{ code: string; name: string }> = []
  for (const row of table.rows.slice(table.header_row + 1)) {
    const code = cellText(row[table.columns.code!])
    const name = cellText(row[table.columns.name!])
    if (!code || seen.has(code.toUpperCase())) continue
    seen.add(code.toUpperCase())
    out.push({ code, name: name || code })
  }
  return out
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Accept ISO text, JS dates and Excel serial numbers; return YYYY-MM-DD or null. */
export function parseEntryDate(value: Cell): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    return value.toISOString().slice(0, 10)
  }
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value)
    if (!parsed || !parsed.y) return null
    return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`
  }
  const match = ISO_DATE.exec(cellText(value))
  if (!match) return null
  const [, y, m, d] = match
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  if (date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) return null
  return `${y}-${m}-${d}`
}

/** Hours as a number with at most two decimals, accepting a Swedish decimal comma. */
export function parseHours(value: Cell): number | null {
  let num: number
  if (typeof value === 'number') {
    num = value
  } else {
    const text = cellText(value).replace(/\s/g, '').replace(',', '.')
    if (!/^\d+(\.\d+)?$/.test(text)) return null
    num = Number(text)
  }
  if (!Number.isFinite(num) || num <= 0 || num > MAX_HOURS_PER_ENTRY) return null
  return Math.round(num * 100) / 100
}

/**
 * Stable per-row key. Identical rows do occur in real sheets (the same task
 * logged twice in a day), so the nth occurrence of the same content gets
 * suffix n: re-importing the file maps every row back onto its own key.
 */
function importKey(content: string, occurrence: number): string {
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 32)
  return `wb:${hash}:${occurrence}`
}

export function parseTimeWorkbook(workbook: XLSX.WorkBook): ParsedTimeWorkbook {
  const table = findTableInWorkbook(workbook, TRANSACTION_COLUMNS, ['date', 'consultant', 'customer', 'hours'])
  if (!table) throw new TimeWorkbookError('NO_TRANSACTIONS_TABLE')

  const col = (row: Cell[], key: ColumnKey): Cell => {
    const idx = table.columns[key]
    return idx === undefined ? null : row[idx] ?? null
  }

  const rows: ParsedTimeRow[] = []
  const skipped: SkippedRow[] = []
  const occurrences = new Map<string, number>()

  table.rows.slice(table.header_row + 1).forEach((row, i) => {
    const sourceRow = table.header_row + 2 + i
    if (row.every((c) => cellText(c) === '')) return

    const rawDate = col(row, 'date')
    const entryDate = parseEntryDate(rawDate)
    if (!entryDate) {
      skipped.push({ source_row: sourceRow, reason: 'invalid_date', value: cellText(rawDate) })
      return
    }
    const consultant = cellText(col(row, 'consultant')).toUpperCase()
    if (!consultant) {
      skipped.push({ source_row: sourceRow, reason: 'missing_consultant', value: '' })
      return
    }
    const customerCode = cellText(col(row, 'customer')).toUpperCase()
    if (!customerCode) {
      skipped.push({ source_row: sourceRow, reason: 'missing_customer', value: '' })
      return
    }
    const rawHours = col(row, 'hours')
    const hours = parseHours(rawHours)
    if (hours === null) {
      skipped.push({ source_row: sourceRow, reason: 'invalid_hours', value: cellText(rawHours) })
      return
    }

    const projectCode = optionalText(col(row, 'project'))
    const activityCode = optionalText(col(row, 'activity'))
    const comment = optionalText(col(row, 'comment'))
    const content = JSON.stringify([entryDate, consultant, customerCode, projectCode, activityCode, hours, comment])
    const n = (occurrences.get(content) ?? 0) + 1
    occurrences.set(content, n)

    rows.push({
      source_row: sourceRow,
      entry_date: entryDate,
      consultant,
      customer_code: customerCode,
      project_code: projectCode,
      activity_code: activityCode,
      hours,
      comment: comment ? comment.slice(0, 1000) : null,
      import_key: importKey(content, n),
    })
  })

  const consultants = readRegister(workbook, ['medarbetarkod', 'medarb'], ['namn'])
    .map(({ code, name }) => ({ code: code.toUpperCase(), name }))
  const activity_codes = readRegister(workbook, ['akod', 'arbetskod'], ['benämning', 'namn'])
    .map(({ code, name }) => ({ code, name, hourly_rate: null }))
  const customers = readRegister(workbook, ['kundkod'], ['namn'])
    .map(({ code, name }) => ({ code: code.toUpperCase(), name }))

  return { consultants, activity_codes, customers, rows, skipped }
}
