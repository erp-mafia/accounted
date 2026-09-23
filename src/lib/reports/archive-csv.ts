/**
 * CSV renditions of the key reports for the full archive.
 *
 * The JSON files in the archive are complete but hostile to humans: a user,
 * their revisor, or a Skatteverket auditor opening the backup years later
 * needs something Excel can read. Conventions target Swedish Excel:
 * semicolon separator (comma is the decimal sign in sv-SE), decimal comma,
 * CRLF line endings and a UTF-8 BOM so å/ä/ö render correctly.
 */
import type {
  TrialBalanceRow,
  IncomeStatementReport,
  IncomeStatementSection,
  BalanceSheetReport,
} from '@/types'
import type { GeneralLedgerReport } from './general-ledger'

export interface TrialBalanceLike {
  rows: TrialBalanceRow[]
  totalDebit: number
  totalCredit: number
}

const BOM = '\uFEFF'
const SEP = ';'
const EOL = '\r\n'

function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') {
    // Swedish Excel: decimal comma, no thousands separator.
    return value.toFixed(2).replace('.', ',')
  }
  if (/[";\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

function csv(rows: (string | number | null | undefined)[][]): string {
  return BOM + rows.map((r) => r.map(csvField).join(SEP)).join(EOL) + EOL
}

export function trialBalanceToCsv(report: TrialBalanceLike): string {
  const rows: (string | number | null)[][] = [
    [
      'Konto',
      'Benämning',
      'IB debet',
      'IB kredit',
      'Period debet',
      'Period kredit',
      'UB debet',
      'UB kredit',
    ],
  ]
  for (const r of report.rows) {
    rows.push([
      r.account_number,
      r.account_name,
      r.opening_debit,
      r.opening_credit,
      r.period_debit,
      r.period_credit,
      r.closing_debit,
      r.closing_credit,
    ])
  }
  rows.push(['Summa', '', null, null, report.totalDebit, report.totalCredit, null, null])
  return csv(rows)
}

function sectionRows(
  sections: IncomeStatementSection[],
  out: (string | number | null)[][]
): void {
  for (const section of sections) {
    for (const row of section.rows) {
      out.push([section.title, row.account_number, row.account_name, row.amount])
    }
    out.push([`Summa ${section.title.toLowerCase()}`, '', '', section.subtotal])
  }
}

export function incomeStatementToCsv(report: IncomeStatementReport): string {
  const rows: (string | number | null)[][] = [
    ['Rubrik', 'Konto', 'Benämning', 'Belopp'],
  ]
  sectionRows(report.revenue_sections, rows)
  rows.push(['Summa intäkter', '', '', report.total_revenue])
  sectionRows(report.expense_sections, rows)
  rows.push(['Summa kostnader', '', '', report.total_expenses])
  sectionRows(report.financial_sections, rows)
  rows.push(['Summa finansiella poster', '', '', report.total_financial])
  rows.push(['Årets resultat', '', '', report.net_result])
  return csv(rows)
}

export function balanceSheetToCsv(report: BalanceSheetReport): string {
  const rows: (string | number | null)[][] = [
    ['Rubrik', 'Konto', 'Benämning', 'Belopp'],
  ]
  sectionRows(report.asset_sections, rows)
  rows.push(['Summa tillgångar', '', '', report.total_assets])
  sectionRows(report.equity_liability_sections, rows)
  rows.push(['Summa eget kapital och skulder', '', '', report.total_equity_liabilities])
  return csv(rows)
}

export function generalLedgerToCsv(report: GeneralLedgerReport): string {
  const rows: (string | number | null)[][] = [
    [
      'Konto',
      'Benämning',
      'Datum',
      'Verifikat',
      'Beskrivning',
      'Debet',
      'Kredit',
      'Saldo',
    ],
  ]
  for (const account of report.accounts) {
    rows.push([
      account.account_number,
      account.account_name,
      '',
      '',
      'Ingående balans',
      null,
      null,
      account.opening_balance,
    ])
    for (const line of account.lines) {
      rows.push([
        account.account_number,
        account.account_name,
        line.date,
        `${line.voucher_series}${line.voucher_number}`,
        line.description,
        line.debit,
        line.credit,
        line.balance,
      ])
    }
    rows.push([
      account.account_number,
      account.account_name,
      '',
      '',
      'Utgående balans',
      account.total_debit,
      account.total_credit,
      account.closing_balance,
    ])
  }
  return csv(rows)
}
