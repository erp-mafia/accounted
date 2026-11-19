import { describe, expect, it } from 'vitest'
import { manualAgreementSchedule, manualDeadlineNote, type ManualAgreementTerms } from '../schedule'

const TODAY = '2026-10-29'

const rent: ManualAgreementTerms = {
  kind: 'rental',
  title: 'Hyresavtal kontor',
  status: 'active',
  starts_on: '2026-01-01',
  ends_on: '2028-12-31',
  first_due_on: null,
  notice_months: 9,
  renewal_terms: 'Förlängs tre år i taget',
  amount: 12500,
  currency: 'SEK',
  period: 'monthly',
}

describe('manualAgreementSchedule', () => {
  it('lays out monthly payments from 60 days back to a year ahead, money leaving the company', () => {
    const { obligations } = manualAgreementSchedule(rent, TODAY)
    const dates = obligations.map((o) => o.dueOn)
    expect(dates[0]).toBe('2026-09-01')
    expect(dates[dates.length - 1]).toBe('2027-10-01')
    expect(dates).toHaveLength(14)
    expect(obligations.every((o) => o.amount === 12500 && o.direction === 'out' && o.kind === 'payment' && !o.estimate)).toBe(true)
    expect(obligations[0].fields).toEqual(['amount', 'period', 'starts_on'])
  })

  it('follows the first due date and the period, and stops at the end', () => {
    const { obligations } = manualAgreementSchedule(
      { ...rent, period: 'quarterly', first_due_on: '2026-03-25', ends_on: '2027-04-30' },
      TODAY,
    )
    expect(obligations.map((o) => o.dueOn)).toEqual(['2026-09-25', '2026-12-25', '2027-03-25'])
    expect(obligations[0].fields).toContain('first_due_on')
  })

  it('expects a customer fee to arrive rather than leave', () => {
    const { obligations } = manualAgreementSchedule({ ...rent, kind: 'customer' }, TODAY)
    expect(obligations.every((o) => o.direction === 'in')).toBe(true)
  })

  it('places a one-time payment only inside the window and before the end', () => {
    expect(manualAgreementSchedule({ ...rent, period: 'one_time', starts_on: '2026-11-15' }, TODAY).obligations.map((o) => o.dueOn)).toEqual(['2026-11-15'])
    expect(manualAgreementSchedule({ ...rent, period: 'one_time', starts_on: '2025-01-01' }, TODAY).obligations).toEqual([])
  })

  it('expects nothing without an amount, a period or a date to count from', () => {
    expect(manualAgreementSchedule({ ...rent, amount: null }, TODAY).obligations).toEqual([])
    expect(manualAgreementSchedule({ ...rent, amount: 0 }, TODAY).obligations).toEqual([])
    expect(manualAgreementSchedule({ ...rent, period: null }, TODAY).obligations).toEqual([])
    expect(manualAgreementSchedule({ ...rent, starts_on: null }, TODAY).obligations).toEqual([])
  })

  it('rounds the amount to the öre', () => {
    const { obligations } = manualAgreementSchedule({ ...rent, amount: 100.005 }, TODAY)
    expect(obligations[0].amount).toBe(100.01)
  })

  it('gives the notice date and the end date, with the renewal named', () => {
    const { deadlines } = manualAgreementSchedule(rent, TODAY)
    expect(deadlines).toEqual([
      { key: 'notice', title: 'Sista dag att säga upp: Hyresavtal kontor', dueOn: '2028-03-31', priority: 'important', fields: ['ends_on', 'notice_months'] },
      { key: 'end', title: 'Hyresavtal kontor löper ut, förlängs annars', dueOn: '2028-12-31', priority: 'normal', fields: ['ends_on'] },
    ])
  })

  it('gives a loan its maturity instead of a notice and an end', () => {
    const { deadlines } = manualAgreementSchedule({ ...rent, kind: 'loan', title: 'Lån Handelsbanken', renewal_terms: null }, TODAY)
    expect(deadlines).toEqual([
      { key: 'maturity', title: 'Lån Handelsbanken förfaller till slutbetalning', dueOn: '2028-12-31', priority: 'important', fields: ['ends_on'] },
    ])
  })

  it('leaves out dates that have passed, and every date of an ended agreement', () => {
    expect(manualAgreementSchedule({ ...rent, ends_on: '2027-03-31' }, TODAY).deadlines.map((d) => d.key)).toEqual(['end'])
    expect(manualAgreementSchedule({ ...rent, status: 'ended' }, TODAY).deadlines).toEqual([])
  })

  it('a permit or a domain expires: an end date without payments', () => {
    const { obligations, deadlines } = manualAgreementSchedule(
      { ...rent, kind: 'domain', title: 'Domänen exempel.se', amount: null, period: null, notice_months: null, renewal_terms: null, ends_on: '2027-05-01' },
      TODAY,
    )
    expect(obligations).toEqual([])
    expect(deadlines).toEqual([{ key: 'end', title: 'Domänen exempel.se löper ut', dueOn: '2027-05-01', priority: 'normal', fields: ['ends_on'] }])
  })
})

describe('manualDeadlineNote', () => {
  it('names the agreement and the fields the date was computed from', () => {
    expect(manualDeadlineNote(' Hyresavtal kontor ', { key: 'notice', title: '', dueOn: '2028-03-31', priority: 'important', fields: ['ends_on', 'notice_months'] })).toBe(
      'Från avtalet Hyresavtal kontor i Avtal och åtaganden. Datumet räknas fram från ends_on, notice_months.',
    )
  })
})
