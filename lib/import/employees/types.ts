import type { ImportNotice } from '@/lib/import/notices'

/**
 * Employee register import (CSV / XLSX).
 *
 * A row becomes the exact payload the "Ny anställd" dialog posts to
 * POST /api/salary/employees (CreateEmployeeSchema input), plus an optional
 * cutover block that becomes an employee_opening_balances row. The parser
 * validates with the same Zod schema as the dialog so a file row fails with
 * the same message a hand-typed form would.
 */

/** Result of auto-detecting columns in an employee register file. */
export interface DetectedEmployeeColumns {
  first_name_col: number | null
  last_name_col: number | null
  /** Combined "Namn" column, used only when first/last are both absent. */
  full_name_col: number | null
  personnummer_col: number | null
  email_col: number | null
  phone_col: number | null
  employment_start_col: number | null
  employment_degree_col: number | null
  salary_type_col: number | null
  monthly_salary_col: number | null
  hourly_rate_col: number | null
  tax_table_col: number | null
  tax_column_col: number | null
  municipality_col: number | null
  clearing_number_col: number | null
  bank_account_col: number | null
  vacation_days_col: number | null
  hours_per_week_col: number | null
  /** Cutover (ingående saldon) columns: any value makes the row carry a block. */
  ytd_gross_col: number | null
  ytd_tax_col: number | null
  ytd_net_col: number | null
  vacation_paid_days_remaining_col: number | null
  cutover_date_col: number | null
  /** 0-1 confidence score for the detection */
  confidence: number
}

/** CreateEmployeeSchema input, as assembled from one file row. */
export interface EmployeeImportPayload {
  first_name: string
  last_name: string
  /** 12 digits when the cell parsed; the raw cell otherwise (row is invalid). */
  personnummer: string
  employment_type: 'employee'
  employment_start: string
  employment_degree: number
  hours_per_week: number
  workdays_per_week: number
  salary_type: 'monthly' | 'hourly'
  monthly_salary?: number
  hourly_rate?: number
  tax_table_number?: number
  tax_column: number
  tax_municipality?: string
  is_sidoinkomst: boolean
  f_skatt_status: 'a_skatt'
  clearing_number?: string
  bank_account_number?: string
  vacation_rule: 'procentregeln'
  vacation_days_per_year: number
  email?: string
  phone?: string
}

/** OpeningBalancesFieldsSchema input for the cutover block. */
export interface EmployeeOpeningBalancesPayload {
  cutover_date: string
  ytd_gross: number
  ytd_tax: number
  ytd_net: number
  vacation_paid_days_remaining: number
}

/** A single parsed row from the employee register file. */
export interface ParsedEmployeeRow {
  row_index: number
  display_name: string
  /** YYYYMMDD-XXXX for the preview; the full number rides in `employee`. */
  personnummer_masked: string
  employee: EmployeeImportPayload
  opening_balances: EmployeeOpeningBalancesPayload | null
  is_valid: boolean
  validation_errors: string[]
}

/** Parsed row + dedup annotation produced by the API route. */
export interface AnnotatedEmployeeRow extends ParsedEmployeeRow {
  duplicate_match: {
    employee_id: string
    existing_name: string
    is_active: boolean
  } | null
}

/** Full result from parsing an employee register file. */
export interface EmployeeImportParseResult {
  filename: string
  sheet_name: string
  total_rows: number
  detected_columns: DetectedEmployeeColumns
  headers: string[]
  preview_rows: string[][]
  rows: AnnotatedEmployeeRow[]
  duplicate_count: number
  warnings: string[]
  notices: ImportNotice[]
}

/** One row as posted to the execute route. */
export interface EmployeeImportExecuteRow {
  row_index: number
  employee: EmployeeImportPayload
  opening_balances: EmployeeOpeningBalancesPayload | null
}

/** Result of executing the employee import. */
export interface EmployeeImportExecuteResult {
  success: boolean
  created: number
  updated: number
  skipped: number
  failed: number
  errors: { row_index: number; name: string; reason: string }[]
  /** Employees whose cutover block was written. */
  opening_balances_set: number
  warnings: string[]
  notices: ImportNotice[]
}
