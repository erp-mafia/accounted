/**
 * Bank file import types
 *
 * Supports Swedish bank CSV formats (Nordea, SEB, Swedbank, Handelsbanken)
 * and ISO 20022 camt.053 XML.
 */

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
}

/** Result from parsing a bank file */
export interface BankFileParseResult {
  format: BankFileFormatId
  format_name: string
  transactions: ParsedBankTransaction[]
  date_from: string | null
  date_to: string | null
  issues: BankFileParseIssue[]
  stats: {
    total_rows: number
    parsed_rows: number
    skipped_rows: number
    total_income: number
    total_expenses: number
  }
}

/** Issue encountered during parsing */
export interface BankFileParseIssue {
  row: number
  message: string
  severity: 'warning' | 'error'
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

/** Import tracking record stored in DB */
export interface BankFileImport {
  id: string
  user_id: string
  filename: string
  file_hash: string
  file_format: string
  transaction_count: number
  imported_count: number
  duplicate_count: number
  matched_count: number
  date_from: string | null
  date_to: string | null
  status: 'pending' | 'processing' | 'completed' | 'failed'
  error_message: string | null
  created_at: string
  updated_at: string
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
  decimal_separator: ',' | '.'
  skip_rows: number
  date_format: string // e.g. 'YYYY-MM-DD'
}
