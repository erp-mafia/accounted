import { describe, expect, it } from 'vitest'
import {
  expenseBalanceAccountAfterEdit,
  isAccruedBalanceAccount,
  isAccruedCostAccount,
  isAccruedIncomeAccount,
  isValidBalanceAccount,
  periodEndsBeforeInvoiceMonth,
  revenueBalanceAccountAfterEdit,
  suggestBalanceAccount,
  suggestExpenseBalanceAccount,
  suggestRevenueBalanceAccount,
} from '@/lib/bookkeeping/accruals/account-suggestions'

describe('suggestBalanceAccount', () => {
  it('maps cost accounts to the BAS-conventional interim account', () => {
    expect(suggestBalanceAccount('expense', '5010')).toBe('1710') // lokalhyra
    expect(suggestBalanceAccount('expense', '5220')).toBe('1720') // hyra inventarier
    expect(suggestBalanceAccount('expense', '5615')).toBe('1720') // leasing personbil
    expect(suggestBalanceAccount('expense', '6310')).toBe('1730') // försäkring
    expect(suggestBalanceAccount('expense', '8410')).toBe('1740') // ränta
    expect(suggestBalanceAccount('expense', '6540')).toBe('1790') // IT-tjänster -> övrigt
  })

  it('always suggests 2970 for revenue', () => {
    expect(suggestBalanceAccount('revenue', '3001')).toBe('2970')
    expect(suggestBalanceAccount('revenue', '3041')).toBe('2970')
  })
})

describe('isValidBalanceAccount', () => {
  it('mirrors the DB CHECK ranges', () => {
    expect(isValidBalanceAccount('expense', '1730')).toBe(true)
    expect(isValidBalanceAccount('expense', '1790')).toBe(true)
    // Upplupen kostnad (20261016004700): any 29xx on an expense schedule.
    expect(isValidBalanceAccount('expense', '2990')).toBe(true)
    expect(isValidBalanceAccount('expense', '2960')).toBe(true)
    expect(isValidBalanceAccount('expense', '1510')).toBe(false)
    expect(isValidBalanceAccount('expense', '5010')).toBe(false)
    expect(isValidBalanceAccount('revenue', '2970')).toBe(true)
    expect(isValidBalanceAccount('revenue', '2990')).toBe(true)
    // Upplupen intäkt (20261021002400): any 17xx on a revenue schedule.
    expect(isValidBalanceAccount('revenue', '1790')).toBe(true)
    expect(isValidBalanceAccount('revenue', '1750')).toBe(true)
    expect(isValidBalanceAccount('revenue', '1510')).toBe(false)
    expect(isValidBalanceAccount('revenue', '3001')).toBe(false)
    expect(isValidBalanceAccount('revenue', '179')).toBe(false)
  })
})

describe('upplupen intäkt (17xx)', () => {
  it('recognises a 17xx account and nothing else', () => {
    expect(isAccruedIncomeAccount('1790')).toBe(true)
    expect(isAccruedIncomeAccount('1750')).toBe(true)
    expect(isAccruedIncomeAccount('2970')).toBe(false)
    expect(isAccruedIncomeAccount('179')).toBe(false)
    expect(isAccruedIncomeAccount(null)).toBe(false)
  })

  it('reads upplupen per direction: 29xx on a cost, 17xx on revenue', () => {
    expect(isAccruedBalanceAccount('expense', '2990')).toBe(true)
    expect(isAccruedBalanceAccount('expense', '1790')).toBe(false)
    expect(isAccruedBalanceAccount('revenue', '1790')).toBe(true)
    expect(isAccruedBalanceAccount('revenue', '2970')).toBe(false)
  })

  it('suggests 1790 for a period wholly before the invoice month', () => {
    expect(suggestRevenueBalanceAccount('2026-09-30', '2026-10-15')).toBe('1790')
    expect(suggestRevenueBalanceAccount('2025-12-31', '2026-01-20')).toBe('1790')
  })

  it('keeps 2970 when the period reaches the invoice month or a date is missing', () => {
    expect(suggestRevenueBalanceAccount('2026-10-31', '2026-10-15')).toBe('2970')
    expect(suggestRevenueBalanceAccount('2026-12-31', '2026-10-15')).toBe('2970')
    expect(suggestRevenueBalanceAccount('', '2026-10-15')).toBe('2970')
    expect(suggestRevenueBalanceAccount('2026-09-30', null)).toBe('2970')
  })
})

describe('revenueBalanceAccountAfterEdit', () => {
  const invoiceDate = '2026-10-15'

  it('moves 2970 to 1790 when the dates move wholly before the invoice month', () => {
    expect(
      revenueBalanceAccountAfterEdit(
        { start: '2026-10-15', end: '', balanceAccount: '2970' },
        { start: '2026-09-01', end: '2026-09-30', balanceAccount: '2970' },
        invoiceDate,
      ),
    ).toBe('1790')
  })

  it('moves a 17xx account back to 2970 when the period reaches the invoice month', () => {
    expect(
      revenueBalanceAccountAfterEdit(
        { start: '2026-09-01', end: '2026-09-30', balanceAccount: '1790' },
        { start: '2026-09-01', end: '2026-12-31', balanceAccount: '1790' },
        invoiceDate,
      ),
    ).toBe('2970')
  })

  it('keeps an account of the right kind, and always the one the user picked', () => {
    expect(
      revenueBalanceAccountAfterEdit(
        { start: '2026-08-01', end: '2026-08-31', balanceAccount: '1780' },
        { start: '2026-08-01', end: '2026-09-30', balanceAccount: '1780' },
        invoiceDate,
      ),
    ).toBe('1780')
    expect(
      revenueBalanceAccountAfterEdit(
        { start: '2026-09-01', end: '2026-09-30', balanceAccount: '1790' },
        { start: '2026-09-01', end: '2026-09-30', balanceAccount: '2979' },
        invoiceDate,
      ),
    ).toBe('2979')
  })
})

describe('upplupen kostnad (29xx)', () => {
  it('recognises a 29xx account and nothing else', () => {
    expect(isAccruedCostAccount('2990')).toBe(true)
    expect(isAccruedCostAccount('2960')).toBe(true)
    expect(isAccruedCostAccount('1790')).toBe(false)
    expect(isAccruedCostAccount('299')).toBe(false)
    expect(isAccruedCostAccount(null)).toBe(false)
    expect(isAccruedCostAccount(undefined)).toBe(false)
  })

  it('needs the period to end before the invoice month', () => {
    expect(periodEndsBeforeInvoiceMonth('2026-09-30', '2026-10-05')).toBe(true)
    expect(periodEndsBeforeInvoiceMonth('2025-12-31', '2026-01-20')).toBe(true)
    expect(periodEndsBeforeInvoiceMonth('2026-10-01', '2026-10-05')).toBe(false)
    expect(periodEndsBeforeInvoiceMonth('2026-10-31', '2026-10-05')).toBe(false)
    expect(periodEndsBeforeInvoiceMonth('2026-11-30', '2026-10-05')).toBe(false)
  })

  it('suggests 2990 (2960 for interest) for a period wholly before the invoice month', () => {
    expect(suggestExpenseBalanceAccount('5020', '2026-09-30', '2026-10-05')).toBe('2990')
    expect(suggestExpenseBalanceAccount('8410', '2026-09-30', '2026-10-05')).toBe('2960')
    expect(suggestExpenseBalanceAccount('', '2026-09-30', '2026-10-05')).toBe('2990')
  })

  it('keeps the 17xx suggestion when the period reaches the invoice month or a date is missing', () => {
    expect(suggestExpenseBalanceAccount('6310', '2026-12-31', '2026-10-05')).toBe('1730')
    expect(suggestExpenseBalanceAccount('6540', '2026-10-31', '2026-10-05')).toBe('1790')
    expect(suggestExpenseBalanceAccount('6540', '', '2026-10-05')).toBe('1790')
    expect(suggestExpenseBalanceAccount('6540', '2026-09-30', null)).toBe('1790')
  })
})

describe('expenseBalanceAccountAfterEdit', () => {
  const invoiceDate = '2026-10-05'

  it('moves a 17xx account to 2990 when the dates move wholly before the invoice month', () => {
    expect(
      expenseBalanceAccountAfterEdit(
        { start: '2026-10-05', end: '', balanceAccount: '1790' },
        { start: '2026-07-01', end: '2026-09-30', balanceAccount: '1790' },
        '5020',
        invoiceDate,
      ),
    ).toBe('2990')
  })

  it('moves a 29xx account back to the 17xx suggestion when the period reaches the invoice month', () => {
    expect(
      expenseBalanceAccountAfterEdit(
        { start: '2026-07-01', end: '2026-09-30', balanceAccount: '2990' },
        { start: '2026-07-01', end: '2026-12-31', balanceAccount: '2990' },
        '6310',
        invoiceDate,
      ),
    ).toBe('1730')
  })

  it('keeps an account of the right kind, and always the one the user picked', () => {
    // Dates move inside the same kind: the chosen 1710 stays.
    expect(
      expenseBalanceAccountAfterEdit(
        { start: '2026-10-01', end: '2026-12-31', balanceAccount: '1710' },
        { start: '2026-10-01', end: '2027-03-31', balanceAccount: '1710' },
        '6310',
        invoiceDate,
      ),
    ).toBe('1710')
    // The user picks 1790 for a past period: it stands (the API then refuses
    // nothing, a 17xx line keeps today's behaviour).
    expect(
      expenseBalanceAccountAfterEdit(
        { start: '2026-07-01', end: '2026-09-30', balanceAccount: '2990' },
        { start: '2026-07-01', end: '2026-09-30', balanceAccount: '1790' },
        '5020',
        invoiceDate,
      ),
    ).toBe('1790')
  })
})
