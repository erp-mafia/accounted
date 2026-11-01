/**
 * Bank file import types
 *
 * Supports Swedish bank CSV formats (Nordea, SEB, Swedbank, Handelsbanken)
 * and ISO 20022 camt.053 XML.
 */

import type { UnrecognizedColumns } from './columns'

/** Parsed and normalized bank transaction from any file format */
export interface ParsedBankTransaction {
  date: string // YYYY-MM-DD
  description: string
  amount: number // Positive = income, negative = expense
  currency: string
  balance?: number | null
  reference?: string | null // OCR number, Bankgiro reference
  counterparty?: string | null
  raw_line?: string // Original CSV line for debugging
  // What the file says beyond the booking date; camt.053 carries these.
  value_date?: string | null // YYYY-MM-DD
  end_to_end_id?: string | null
  provider_transaction_id?: string | null // The bank's own id for the entry
  counterparty_iban?: string | null
  bank_transaction_code?: string | null // ISO 20022 domain-family-subfamily, e.g. PMNT-RCDT-ESCT
}

/**
 * The bank account the statement itself is for, as the file states it:
 * camt.053 by IBAN in <Stmt><Acct>, Swedbank by its clearing and account
 * columns, Handelsbanken, ICA Banken and Northmill in a "Kontonummer" line
 * above the rows. Matched to a cash account by matchFileAccount
 * (lib/cash-accounts/file-account.ts).
 */
export interface BankFileAccountIdentity {
  /** Normalized IBAN (no spaces, upper case). */
  iban: string | null
  /** Clearing number as printed, when the file gives it in its own column. */
  clearing: string | null
  /** Account number as printed; may lead with the clearing number. */
  account_number: string | null
}

/** Result from parsing a bank file */
export interface BankFileParseResult {
  format: BankFileFormatId
  format_name: string
  transactions: ParsedBankTransaction[]
  /**
   * The statement's own account. Absent or null when the format does not
   * say, or the file holds rows of more than one account.
   */
  account?: BankFileAccountIdentity | null
  date_from: string | null
  date_to: string | null
  issues: BankFileParseIssue[]
  /**
   * Set when the format found no column it could read: the columns the file
   * does have and the ones the format expects. The parse routes answer it
   * with BANK_FILE_COLUMNS_UNRECOGNIZED instead of an empty preview.
   */
  unrecognized_columns?: UnrecognizedColumns
  stats: {
    total_rows: number
    parsed_rows: number
    skipped_rows: number
    total_income: number
    total_expenses: number
  }
}

/**
 * Advisory duplicate preview from POST /api/import/bank-file/check-duplicates:
 * rows that already exist and that execute-side ingest will skip. Never a
 * promise of the exact final count; ingest's own result stays authoritative.
 */
export interface BankFileDuplicateInfo {
  /** Indexes into the parsed transactions array, ascending. */
  duplicate_row_indexes: number[]
  duplicate_count: number
}

/** Issue encountered during parsing */
export interface BankFileParseIssue {
  row: number
  message: string
  severity: 'info' | 'warning' | 'error'
}

/** Supported bank file format identifiers */
export type BankFileFormatId =
  | 'nordea'
  | 'nordea_business'
  | 'seb'
  | 'swedbank'
  | 'handelsbanken'
  | 'lansforsakringar'
  | 'ica_banken'
  | 'skandia'
  | 'lunar'
  | 'northmill'
  | 'wise'
  | 'wise_statement'
  | 'generic_csv'
  | 'camt053'

/** Format definition with detection and parsing capability */
export interface BankFileFormat {
  id: BankFileFormatId
  name: string
  description: string
  fileExtensions: string[]
  detect: (content: string, filename: string) => boolean
  parse: (content: string) => BankFileParseResult
}

/** Column mapping for generic CSV format */
export interface GenericCSVColumnMapping {
  date: number
  description: number
  amount: number
  reference?: number
  counterparty?: number
  balance?: number
  delimiter: string
  /** The mark a person chose. Null: nobody did, and the file itself must settle it. */
  decimal_separator: ',' | '.' | null
  skip_rows: number
  date_format: string // e.g. 'YYYY-MM-DD'
}
