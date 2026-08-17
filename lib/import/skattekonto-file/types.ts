/**
 * Types for the skattekontoutdrag file importer.
 *
 * Deliberately separate from the bank-file importer: skattekonto rows are
 * not bank transactions. They land in skattekonto_transactions (not
 * transactions) and are booked through the skattekonto rules engine against
 * 1630, so the parse result mirrors that table's vocabulary.
 */

export interface ParsedSkattekontoFileRow {
  /** YYYY-MM-DD */
  transaktionsdatum: string
  transaktionstext: string
  /** SKV sign convention: positive = credit on the tax account. */
  belopp: number
  raw_line: string
}

export interface SkattekontoFileParseIssue {
  /** 1-based line number in the file */
  row: number
  message: string
  severity: 'info' | 'warning' | 'error'
}

export interface SkattekontoFileParseResult {
  variant: 'csv' | 'skv'
  /** From the header row of the modern export; null on legacy files. */
  company_name: string | null
  /** Formatted NNNNNN-NNNN from the header row; null on legacy files. */
  org_number: string | null
  rows: ParsedSkattekontoFileRow[]
  date_from: string | null
  date_to: string | null
  /** "Ingående saldo" marker row amount; null when the file has none. */
  opening_saldo: number | null
  /** "Utgående saldo" marker row amount; null when the file has none. */
  closing_saldo: number | null
  /**
   * opening_saldo + sum(rows) === closing_saldo, checked when both markers
   * exist. False means the file is truncated or hand-edited and must not be
   * imported silently. Null when the file carries no saldo markers.
   */
  sum_valid: boolean | null
  issues: SkattekontoFileParseIssue[]
  stats: {
    total_rows: number
    parsed_rows: number
    skipped_rows: number
  }
}
