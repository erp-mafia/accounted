/** Layout of the balance columns in the uploaded file */
export type BalanceColumnLayout = 'net' | 'debit_credit'

/** Result of auto-detecting columns in the uploaded file */
export interface DetectedColumns {
  account_number_col: number
  account_name_col: number | null
  layout: BalanceColumnLayout
  /** Column index for net balance (used when layout === 'net') */
  balance_col: number | null
  /** Column index for debit amounts (used when layout === 'debit_credit') */
  debit_col: number | null
  /** Column index for credit amounts (used when layout === 'debit_credit') */
  credit_col: number | null
  /** 0-1 confidence score for the detection */
  confidence: number
}

/** A single parsed row from the opening balance file */
export interface ParsedOpeningBalanceRow {
  row_index: number
  account_number: string
  account_name: string
  debit_amount: number
  credit_amount: number
  is_valid: boolean
  validation_errors: string[]
  /** Matched BAS account name, if found */
  bas_match: string | null
}

/** Full result from parsing an opening balance file */
export interface OpeningBalanceParseResult {
  filename: string
  sheet_name: string
  total_rows: number
  detected_columns: DetectedColumns
  /** Raw headers from the first row of the file */
  headers: string[]
  /** First 5 raw data rows for preview in column mapping */
  preview_rows: string[][]
  rows: ParsedOpeningBalanceRow[]
  total_debit: number
  total_credit: number
  is_balanced: boolean
  warnings: string[]
}

/** Input for executing the opening balance import */
export interface OpeningBalanceExecuteInput {
  fiscal_period_id: string
  lines: {
    account_number: string
    debit_amount: number
    credit_amount: number
  }[]
}

/** Result of executing the opening balance import */
export interface OpeningBalanceExecuteResult {
  success: boolean
  journal_entry_id: string | null
  fiscal_period_id: string
  lines_created: number
  total_debit: number
  total_credit: number
  error?: string
  /** Set when this was a correction: the stornoed previous IB entry id. */
  reversed_entry_id?: string | null
}
