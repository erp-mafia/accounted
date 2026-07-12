import { describe, it, expect } from 'vitest'
import {
  trialBalanceToCsv,
  incomeStatementToCsv,
  balanceSheetToCsv,
  generalLedgerToCsv,
} from '../archive-csv'
import type { IncomeStatementReport, BalanceSheetReport } from '@/types'
import type { GeneralLedgerReport } from '../general-ledger'

describe('trialBalanceToCsv', () => {
  const report = {
    rows: [
      {
        account_number: '1930',
        account_name: 'Företagskonto',
        account_class: 1,
        opening_debit: 1000,
        opening_credit: 0,
        period_debit: 500.5,
        period_credit: 200,
        closing_debit: 1300.5,
        closing_credit: 0,
      },
    ],
    totalDebit: 500.5,
    totalCredit: 200,
    isBalanced: false,
  }

  it('starts with a UTF-8 BOM and uses semicolons + decimal commas', () => {
    const csv = trialBalanceToCsv(report)
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    const lines = csv.slice(1).split('\r\n')
    expect(lines[0]).toBe(
      'Konto;Benämning;IB debet;IB kredit;Period debet;Period kredit;UB debet;UB kredit'
    )
    expect(lines[1]).toBe('1930;Företagskonto;1000,00;0,00;500,50;200,00;1300,50;0,00')
    expect(lines[2]).toContain('Summa')
    expect(lines[2]).toContain('500,50;200,00')
  })

  it('quotes fields containing separators or quotes', () => {
    const csv = trialBalanceToCsv({
      ...report,
      rows: [
        {
          ...report.rows[0],
          account_name: 'Kassa; "extra" konto',
        },
      ],
    })
    expect(csv).toContain('"Kassa; ""extra"" konto"')
  })
})

describe('incomeStatementToCsv', () => {
  it('renders sections with subtotals and the net result', () => {
    const report: IncomeStatementReport = {
      revenue_sections: [
        {
          title: 'Nettoomsättning',
          rows: [{ account_number: '3001', account_name: 'Försäljning 25%', amount: 100 }],
          subtotal: 100,
        },
      ],
      total_revenue: 100,
      expense_sections: [
        {
          title: 'Övriga externa kostnader',
          rows: [{ account_number: '6110', account_name: 'Kontorsmateriel', amount: 40 }],
          subtotal: 40,
        },
      ],
      total_expenses: 40,
      financial_sections: [],
      total_financial: 0,
      net_result: 60,
      period: { start: '2024-01-01', end: '2024-12-31' },
    }
    const csv = incomeStatementToCsv(report)
    expect(csv).toContain('Nettoomsättning;3001;Försäljning 25%;100,00')
    expect(csv).toContain('Summa nettoomsättning;;;100,00')
    expect(csv).toContain('Summa intäkter;;;100,00')
    expect(csv).toContain('Summa kostnader;;;40,00')
    expect(csv).toContain('Årets resultat;;;60,00')
  })
})

describe('balanceSheetToCsv', () => {
  it('renders assets and equity/liabilities with totals', () => {
    const report: BalanceSheetReport = {
      asset_sections: [
        {
          title: 'Kassa och bank',
          rows: [{ account_number: '1930', account_name: 'Företagskonto', amount: 5000 }],
          subtotal: 5000,
        },
      ],
      total_assets: 5000,
      equity_liability_sections: [
        {
          title: 'Eget kapital',
          rows: [{ account_number: '2010', account_name: 'Eget kapital', amount: 5000 }],
          subtotal: 5000,
        },
      ],
      total_equity_liabilities: 5000,
      period: { start: '2024-01-01', end: '2024-12-31' },
    }
    const csv = balanceSheetToCsv(report)
    expect(csv).toContain('Kassa och bank;1930;Företagskonto;5000,00')
    expect(csv).toContain('Summa tillgångar;;;5000,00')
    expect(csv).toContain('Summa eget kapital och skulder;;;5000,00')
  })
})

describe('generalLedgerToCsv', () => {
  it('renders opening balance, lines with voucher refs, and closing balance', () => {
    const report: GeneralLedgerReport = {
      accounts: [
        {
          account_number: '1930',
          account_name: 'Företagskonto',
          opening_balance: 1000,
          lines: [
            {
              date: '2024-03-15',
              voucher_series: 'A',
              voucher_number: 17,
              journal_entry_id: 'e-1',
              description: 'Kundbetalning',
              source_type: 'manual',
              debit: 500,
              credit: 0,
              balance: 1500,
            },
          ],
          closing_balance: 1500,
          total_debit: 500,
          total_credit: 0,
        },
      ],
      period: { start: '2024-01-01', end: '2024-12-31' },
    }
    const csv = generalLedgerToCsv(report)
    expect(csv).toContain('1930;Företagskonto;;;Ingående balans;;;1000,00')
    expect(csv).toContain('1930;Företagskonto;2024-03-15;A17;Kundbetalning;500,00;0,00;1500,00')
    expect(csv).toContain('1930;Företagskonto;;;Utgående balans;500,00;0,00;1500,00')
  })
})
