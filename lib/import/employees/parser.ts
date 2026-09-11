import { CreateEmployeeSchema, OpeningBalancesFieldsSchema } from '@/lib/api/schemas'
import { expandPersonnummerTo12, maskPersonnummer, validatePersonnummer } from '@/lib/salary/personnummer-format'
import { deriveTaxColumn } from '@/lib/salary/tax-column'
import { makeNotice, type ImportNotice } from '@/lib/import/notices'
import { normalizeDate } from '../bank-file/date-utils'
import { cellOrNull, parseDecimal } from '../shared/column-utils'
import { readBestSheet } from '../shared/workbook-reader'
import { detectEmployeeColumns } from './column-detector'
import { EMPLOYEE_FIELD_LABELS } from './labels'
import type {
  DetectedEmployeeColumns,
  EmployeeImportPayload,
  EmployeeOpeningBalancesPayload,
  ParsedEmployeeRow,
} from './types'

export interface ParseEmployeesOptions {
  /** Normalised kommun name -> skattetabell number, for rows that give a
   * kommun but no table (Skatteverket open data, resolved by the route). */
  kommunTableByName?: Record<string, number>
  /** Cutover date applied to rows that carry ingående saldon but no
   * brytdatum column. Must be the first of a month. */
  defaultCutoverDate?: string
  /** Injectable clock for personnummer century expansion and tax column. */
  now?: Date
}

const MONTHLY_WORDS = ['månadslön', 'manadslon', 'månad', 'manad', 'monthly', 'month', 'm']
const HOURLY_WORDS = ['timlön', 'timlon', 'timme', 'tim', 'hourly', 'hour', 'h']

function normalizeSalaryType(value: string | null): 'monthly' | 'hourly' | null {
  if (!value) return null
  const lower = value.toLowerCase().trim()
  if (MONTHLY_WORDS.includes(lower) || lower.startsWith('månad') || lower.startsWith('month')) return 'monthly'
  if (HOURLY_WORDS.includes(lower) || lower.startsWith('tim') || lower.startsWith('hour')) return 'hourly'
  return null
}

/** Kommun names as keys: lowercase, trimmed, without a trailing "kommun". */
export function normalizeKommunName(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/\s+kommun$/, '')
    .replace(/\s+/g, ' ')
}

/**
 * Dates come out of the sheet reader as display text. Besides the Swedish
 * and ISO shapes normalizeDate knows, SheetJS renders a true date cell with
 * its default "m/d/yy" format, so that shape is accepted too.
 */
function parseCellDate(raw: string | null): string | null {
  if (!raw) return null
  const iso = normalizeDate(raw)
  if (iso) return iso
  const short = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/)
  if (!short) return null
  const month = Number(short[1])
  const day = Number(short[2])
  const year = 2000 + Number(short[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** "Anna Maria Svensson" -> first "Anna Maria", last "Svensson". */
export function splitFullName(full: string): { first_name: string; last_name: string } {
  const parts = full.trim().split(/\s+/)
  if (parts.length < 2) return { first_name: full.trim(), last_name: '' }
  const last_name = parts[parts.length - 1]
  return { first_name: parts.slice(0, -1).join(' '), last_name }
}

function splitCombinedAccount(raw: string): { clearing: string; account: string } | null {
  const m = raw.trim().match(/^(\d{4,5})[\s-]+(\d[\d\s]*)$/)
  if (!m) return null
  return { clearing: m[1], account: m[2].replace(/\s/g, '') }
}

function firstIssueMessage(path: PropertyKey[], message: string): string {
  const key = String(path[0] ?? '')
  const label = EMPLOYEE_FIELD_LABELS[key]
  return label ? `${label}: ${message}` : message
}

/**
 * Parse an employee-register file (Excel or CSV) and return structured rows.
 * Pure apart from the sheet read: the kommun table map and clock come in
 * through `options` so the route owns every network call.
 */
export function parseEmployeesFile(
  buffer: ArrayBuffer,
  filename: string,
  columnOverrides?: DetectedEmployeeColumns,
  options: ParseEmployeesOptions = {},
): {
  filename: string
  sheet_name: string
  total_rows: number
  detected_columns: DetectedEmployeeColumns
  headers: string[]
  preview_rows: string[][]
  rows: ParsedEmployeeRow[]
  warnings: string[]
  notices: ImportNotice[]
} {
  const { sheetName, rawData } = readBestSheet(buffer, filename)
  const now = options.now ?? new Date()
  const year = now.getFullYear()

  const headers = (rawData[0] ?? []).map((h) => String(h))
  const columns = columnOverrides ?? detectEmployeeColumns(headers)

  if (rawData.length < 2) {
    return {
      filename,
      sheet_name: sheetName,
      total_rows: 0,
      detected_columns: columns,
      headers,
      preview_rows: [],
      rows: [],
      warnings: ['Filen innehåller för få rader.'],
      notices: [makeNotice('employees_too_few_rows', 'action')],
    }
  }

  const dataRows = rawData.slice(1)
  const rows: ParsedEmployeeRow[] = []
  const warnings: string[] = []
  const notices: ImportNotice[] = []
  let kommunUnmapped = 0
  let cutoverRows = 0

  const cell = (row: string[], col: number | null): string | null =>
    col === null ? null : cellOrNull(row[col])

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]
    const rowIndex = i + 2 // 1-based + header

    // Name: first/last columns win; the combined column is split on the
    // last space. A row with neither is blank and skipped silently, like
    // the customer importer skips nameless rows.
    let first_name = cell(row, columns.first_name_col) ?? ''
    let last_name = cell(row, columns.last_name_col) ?? ''
    if (!first_name && !last_name) {
      const full = cell(row, columns.full_name_col)
      if (full) ({ first_name, last_name } = splitFullName(full))
    }
    const personnummerRaw = cell(row, columns.personnummer_col)
    if (!first_name && !last_name && !personnummerRaw) continue

    const errors: string[] = []
    if (!first_name) errors.push('Förnamn saknas')
    if (!last_name) errors.push('Efternamn saknas')

    // Personnummer: 10 or 12 digits, with or without separator, Luhn-checked.
    let personnummer = personnummerRaw ?? ''
    if (!personnummerRaw) {
      errors.push('Personnummer saknas')
    } else {
      const expanded = expandPersonnummerTo12(personnummerRaw, now)
      if (!expanded) {
        errors.push('Personnummer: måste vara 10 eller 12 siffror (ÅÅÅÅMMDDNNNN)')
      } else {
        const check = validatePersonnummer(expanded)
        if (!check.valid) errors.push(`Personnummer: ${check.error}`)
        personnummer = expanded
      }
    }

    // Employment start: required by the schema; parsed from the common shapes.
    const startRaw = cell(row, columns.employment_start_col)
    const employment_start = parseCellDate(startRaw) ?? ''
    if (startRaw && !employment_start) {
      errors.push(`Anställningsdatum: "${startRaw}" är inte ett datum (ange ÅÅÅÅ-MM-DD)`)
    } else if (!startRaw) {
      errors.push('Anställningsdatum saknas')
    }

    // Employment degree: percent; a fraction in (0, 1) is read as a share.
    let employment_degree = 100
    const degreeRaw = parseDecimal(cell(row, columns.employment_degree_col))
    if (degreeRaw !== null) {
      employment_degree = degreeRaw > 0 && degreeRaw < 1 ? Math.round(degreeRaw * 100) : degreeRaw
    }

    // Salary: explicit löneform wins; otherwise whichever amount is present.
    const monthly = parseDecimal(cell(row, columns.monthly_salary_col))
    const hourly = parseDecimal(cell(row, columns.hourly_rate_col))
    const explicitType = normalizeSalaryType(cell(row, columns.salary_type_col))
    const salary_type: 'monthly' | 'hourly' =
      explicitType ?? (hourly !== null && hourly > 0 && !(monthly !== null && monthly > 0) ? 'hourly' : 'monthly')

    // Tax: table from the file, or derived from the kommun when the route
    // supplied the map. Column from the file, else derived from age.
    const tableRaw = parseDecimal(cell(row, columns.tax_table_col))
    const municipality = cell(row, columns.municipality_col) ?? undefined
    let tax_table_number: number | undefined = tableRaw !== null ? tableRaw : undefined
    if (tax_table_number === undefined && municipality && options.kommunTableByName) {
      const mapped = options.kommunTableByName[normalizeKommunName(municipality)]
      if (mapped !== undefined) tax_table_number = mapped
      else kommunUnmapped++
    }
    const columnRaw = parseDecimal(cell(row, columns.tax_column_col))
    const tax_column =
      columnRaw !== null
        ? columnRaw
        : (personnummer.length === 12 ? deriveTaxColumn(personnummer, year) : null) ?? 1

    // Bank: separate columns, or one "Bankkonto" cell split on its separator.
    let clearing_number = cell(row, columns.clearing_number_col) ?? undefined
    let bank_account_number = cell(row, columns.bank_account_col) ?? undefined
    if (!clearing_number && bank_account_number) {
      const split = splitCombinedAccount(bank_account_number)
      if (split) {
        clearing_number = split.clearing
        bank_account_number = split.account
      }
    }

    const vacationDaysRaw = parseDecimal(cell(row, columns.vacation_days_col))
    const hoursRaw = parseDecimal(cell(row, columns.hours_per_week_col))

    const employee: EmployeeImportPayload = {
      first_name,
      last_name,
      personnummer,
      employment_type: 'employee',
      employment_start,
      employment_degree,
      hours_per_week: hoursRaw !== null && hoursRaw > 0 ? hoursRaw : 40,
      workdays_per_week: 5,
      salary_type,
      ...(salary_type === 'monthly' && monthly !== null ? { monthly_salary: monthly } : {}),
      ...(salary_type === 'hourly' && hourly !== null ? { hourly_rate: hourly } : {}),
      ...(tax_table_number !== undefined ? { tax_table_number } : {}),
      tax_column,
      ...(municipality ? { tax_municipality: municipality } : {}),
      is_sidoinkomst: false,
      f_skatt_status: 'a_skatt',
      ...(clearing_number ? { clearing_number } : {}),
      ...(bank_account_number ? { bank_account_number } : {}),
      vacation_rule: 'procentregeln',
      vacation_days_per_year: vacationDaysRaw !== null ? Math.round(vacationDaysRaw) : 25,
      ...(cell(row, columns.email_col) ? { email: cell(row, columns.email_col)! } : {}),
      ...(cell(row, columns.phone_col) ? { phone: cell(row, columns.phone_col)! } : {}),
    }

    // Same gate as the dialog: every schema message the form would show, the
    // file row shows. Paths already reported above are not repeated.
    const reported = new Set(
      errors.map((e) => e.split(':')[0].replace(/ saknas$/, '')),
    )
    const parsed = CreateEmployeeSchema.safeParse(employee)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '')
        const label = EMPLOYEE_FIELD_LABELS[key] ?? key
        if (reported.has(label)) continue
        reported.add(label)
        errors.push(firstIssueMessage(issue.path, issue.message))
      }
    }

    // Cutover block: present when any ingående column carries a value.
    const ytdGross = parseDecimal(cell(row, columns.ytd_gross_col))
    const ytdTax = parseDecimal(cell(row, columns.ytd_tax_col))
    const ytdNet = parseDecimal(cell(row, columns.ytd_net_col))
    const vacationRemaining = parseDecimal(cell(row, columns.vacation_paid_days_remaining_col))
    const cutoverRaw = cell(row, columns.cutover_date_col)
    let opening_balances: EmployeeOpeningBalancesPayload | null = null
    if (ytdGross !== null || ytdTax !== null || ytdNet !== null || vacationRemaining !== null || cutoverRaw) {
      const cutover_date = parseCellDate(cutoverRaw) ?? options.defaultCutoverDate ?? ''
      opening_balances = {
        cutover_date,
        ytd_gross: ytdGross ?? 0,
        ytd_tax: ytdTax ?? 0,
        ytd_net: ytdNet ?? 0,
        vacation_paid_days_remaining: vacationRemaining ?? 0,
      }
      if (!cutover_date) {
        errors.push('Brytdatum saknas för ingående saldon')
      } else {
        const obParsed = OpeningBalancesFieldsSchema.safeParse(opening_balances)
        if (!obParsed.success) {
          for (const issue of obParsed.error.issues) {
            errors.push(firstIssueMessage(issue.path, issue.message))
          }
        }
      }
      cutoverRows++
    }

    rows.push({
      row_index: rowIndex,
      display_name: `${first_name} ${last_name}`.trim(),
      personnummer_masked: personnummer.length === 12 ? maskPersonnummer(personnummer) : personnummer,
      employee,
      opening_balances,
      is_valid: errors.length === 0,
      validation_errors: errors,
    })
  }

  if (columns.personnummer_col === null) {
    warnings.push('Ingen personnummerkolumn hittades. Mappa kolumnen manuellt.')
    notices.push(makeNotice('employees_no_personnummer_column', 'action'))
  }
  if (rows.length === 0) {
    warnings.push('Inga anställda hittades i filen. Kontrollera att namn- och personnummerkolumnerna är rätt mappade.')
    notices.push(makeNotice('employees_no_rows', 'action'))
  }
  if (kommunUnmapped > 0) {
    warnings.push(`${kommunUnmapped} rader har en kommun som inte kunde matchas mot en skattetabell.`)
    notices.push(makeNotice('employees_kommun_unmapped', 'notice', { count: kommunUnmapped }))
  }
  if (cutoverRows > 0) {
    warnings.push(`Ingående saldon hittades för ${cutoverRows} anställda och sparas efter importen.`)
    notices.push(makeNotice('employees_opening_balances_detected', 'info', { count: cutoverRows }))
  }

  return {
    filename,
    sheet_name: sheetName,
    total_rows: rows.length,
    detected_columns: columns,
    headers,
    preview_rows: dataRows.slice(0, 5),
    rows,
    warnings,
    notices,
  }
}
