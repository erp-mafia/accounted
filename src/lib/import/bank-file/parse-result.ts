import type { BankFileFormatId, BankFileParseIssue, BankFileParseResult, ParsedBankTransaction } from './types'
import { roundOre } from '@/lib/money'

/**
 * The end of a format's parse: the date range and the income and expense
 * totals over the rows it read, each total rounded to the öre.
 */
export function finishParseResult(parts: {
  format: BankFileFormatId
  format_name: string
  transactions: ParsedBankTransaction[]
  issues: BankFileParseIssue[]
  totalRows: number
  skippedRows: number
}): BankFileParseResult {
  const { transactions } = parts
  const dates = transactions.map((t) => t.date).sort()
  return {
    format: parts.format,
    format_name: parts.format_name,
    transactions,
    date_from: dates[0] || null,
    date_to: dates[dates.length - 1] || null,
    issues: parts.issues,
    stats: {
      total_rows: parts.totalRows,
      parsed_rows: transactions.length,
      skipped_rows: parts.skippedRows,
      total_income: roundOre(transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0)),
      total_expenses: roundOre(transactions.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0)),
    },
  }
}
