import { describe, expect, it } from 'vitest'
import {
  accrualValueAfterEdit,
  isAccruedBalanceAccount,
  isAccruedCostAccount,
  isAccruedIncomeAccount,
  isValidBalanceAccount,
  periodEndsBeforeInvoiceMonth,
  suggestBalanceAccount,
  suggestExpenseBalanceAccount,
  suggestRevenueBalanceAccount,
  type AccrualPanelValue,
} from '@/lib/bookkeeping/accruals/account-suggestions'

/**
 * Edits applied one after another the way AccrualPeriodControl applies them:
 * each against the value the previous edit rendered. Returns every value.
 */
function typeInto(
  line: Parameters<typeof accrualValueAfterEdit>[0],
  start: AccrualPanelValue,
  edits: Array<Partial<AccrualPanelValue>>,
): AccrualPanelValue[] {
  const values: AccrualPanelValue[] = []
  let value = start
  for (const patch of edits) {
    value = accrualValueAfterEdit(line, value, patch)
    values.push(value)
  }
  return values
}

const accounts = (values: AccrualPanelValue[]) => values.map((v) => v.balanceAccount)

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

describe('accrualValueAfterEdit: a customer invoice line (#112)', () => {
  // The issue's invoice: dated 2026-10-26, the strip opened with the start
  // on the invoice date and 2970.
  const invoiceDate = '2026-10-26'
  const line = { direction: 'revenue' as const, invoiceDate }
  const opened: AccrualPanelValue = { start: invoiceDate, end: '', balanceAccount: '2970' }

  it('switches 2970 to 1790 once the period ends before the invoice month', () => {
    const values = typeInto(line, opened, [{ start: '2026-09-01' }, { end: '2026-09-30' }])
    expect(accounts(values)).toEqual(['2970', '1790'])
    expect(values.at(-1)).toEqual({ start: '2026-09-01', end: '2026-09-30', balanceAccount: '1790' })
  })

  it('switches back to 2970 once the end reaches the invoice month or later', () => {
    const september = { start: '2026-09-01', end: '2026-09-30', balanceAccount: '1790' }
    expect(accounts(typeInto(line, september, [{ end: '2026-11-30' }]))).toEqual(['2970'])
    expect(accounts(typeInto(line, september, [{ end: '2026-10-31' }]))).toEqual(['2970'])
  })

  it('ends on the account the final date suggests when the year is typed digit by digit', () => {
    // Chrome emits a change for every year digit of a date input.
    const digits = (rest: string) => ['0002', '0020', '0202', '2026'].map((year) => ({ end: `${year}${rest}` }))
    expect(accounts(typeInto(line, opened, digits('-09-30'))).at(-1)).toBe('1790')
    expect(accounts(typeInto(line, opened, digits('-11-30'))).at(-1)).toBe('2970')
  })

  it('keeps a picked account, and an account of the right kind while the dates move', () => {
    const novemberOn = { start: '2026-11-01', end: '', balanceAccount: '2970' }
    expect(
      accounts(typeInto(line, novemberOn, [{ balanceAccount: '2971' }, { end: '2026-12-31' }])),
    ).toEqual(['2971', '2971'])
    expect(
      accounts(typeInto(line, { start: '2026-08-01', end: '2026-08-31', balanceAccount: '1780' }, [{ end: '2026-09-30' }])),
    ).toEqual(['1780'])
    // A pick against the suggestion stands too (#113 decides what booking does with it).
    expect(
      accounts(typeInto(line, { start: '2026-09-01', end: '2026-09-30', balanceAccount: '1790' }, [{ balanceAccount: '2979' }])),
    ).toEqual(['2979'])
  })

  it('changes nothing when the edit changes nothing', () => {
    const september = { start: '2026-09-01', end: '2026-09-30', balanceAccount: '2970' }
    expect(accrualValueAfterEdit(line, september, { end: '2026-09-30' })).toEqual(september)
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

describe('accrualValueAfterEdit: a supplier invoice line', () => {
  const invoiceDate = '2026-10-05'
  const costLine = (targetAccount: string) => ({ direction: 'expense' as const, targetAccount, invoiceDate })

  it('switches a 17xx account to 2990 (2960 for interest) once the period ends before the invoice month', () => {
    const opened = (balanceAccount: string) => ({ start: invoiceDate, end: '', balanceAccount })
    const july = [{ start: '2026-07-01' }, { end: '2026-09-30' }]
    expect(accounts(typeInto(costLine('5020'), opened('1710'), july))).toEqual(['1710', '2990'])
    expect(accounts(typeInto(costLine('8410'), opened('1740'), july))).toEqual(['1740', '2960'])
  })

  it('switches a 29xx account back to the 17xx suggestion once the period reaches the invoice month', () => {
    const past = { start: '2026-07-01', end: '2026-09-30', balanceAccount: '2990' }
    expect(accounts(typeInto(costLine('6310'), past, [{ end: '2026-12-31' }]))).toEqual(['1730'])
  })

  it('keeps an account of the right kind, and always the one the user picked', () => {
    // Dates move inside the same kind: the chosen 1710 stays.
    expect(
      accounts(typeInto(costLine('6310'), { start: '2026-10-01', end: '2026-12-31', balanceAccount: '1710' }, [{ end: '2027-03-31' }])),
    ).toEqual(['1710'])
    // The user picks 1790 for a past period: it stands.
    expect(
      accounts(typeInto(costLine('5020'), { start: '2026-07-01', end: '2026-09-30', balanceAccount: '2990' }, [{ balanceAccount: '1790' }])),
    ).toEqual(['1790'])
  })
})
