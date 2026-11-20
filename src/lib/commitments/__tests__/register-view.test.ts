import { describe, expect, it } from 'vitest'
import { columnsWithValues, groupUpcomingPayments } from '../register-view'
import type { ObligationView } from '../types'

const payment = (over: Partial<ObligationView>): ObligationView => ({
  obligation_id: 'o1',
  agreement_id: 'loan',
  agreement_title: 'Lån',
  kind: 'loan',
  due_on: '2026-11-30',
  amount: 10417,
  currency: 'SEK',
  direction: 'out',
  status: 'expected',
  amount_is_estimate: false,
  transaction_id: null,
  ...over,
})

describe('groupUpcomingPayments', () => {
  it('folds an agreement with several payments into one line: the first date and "+N till"', () => {
    const lines = groupUpcomingPayments([
      payment({ obligation_id: 'o3', due_on: '2027-01-31' }),
      payment({ obligation_id: 'o1', due_on: '2026-11-30' }),
      payment({ obligation_id: 'o2', due_on: '2026-12-31' }),
    ])
    expect(lines).toEqual([
      { agreement_id: 'loan', title: 'Lån', due_on: '2026-11-30', amount: 10417, currency: 'SEK', direction: 'out', missed: false, more: 2 },
    ])
  })

  it('keeps one line per agreement, ordered by the first date', () => {
    const lines = groupUpcomingPayments([
      payment({ obligation_id: 'a1', agreement_id: 'rent', agreement_title: 'Hyra', due_on: '2026-12-01', amount: 5000 }),
      payment({ obligation_id: 'l1', due_on: '2026-11-30' }),
      payment({ obligation_id: 'l2', due_on: '2026-12-31' }),
    ])
    expect(lines.map((l) => [l.agreement_id, l.due_on, l.more])).toEqual([
      ['loan', '2026-11-30', 1],
      ['rent', '2026-12-01', 0],
    ])
  })

  it('shows a missed payment first, since it lies before the next expected one', () => {
    const [line] = groupUpcomingPayments([
      payment({ obligation_id: 'next', due_on: '2026-11-30' }),
      payment({ obligation_id: 'late', due_on: '2026-10-15', status: 'missed' }),
    ])
    expect(line).toMatchObject({ due_on: '2026-10-15', missed: true, more: 1 })
  })

  it('is empty without payments', () => {
    expect(groupUpcomingPayments([])).toEqual([])
  })
})

describe('columnsWithValues', () => {
  const cells = {
    counterparty: (r: { counterparty: string | null }) => r.counterparty,
    next_payment: (r: { next: string | null }) => r.next,
    ends: (r: { ends: string | undefined }) => r.ends,
  }
  type Row = { counterparty: string | null; next: string | null; ends: string | undefined }

  it('leaves out a column that is empty on every row', () => {
    const rows: Row[] = [
      { counterparty: 'Banken', next: null, ends: undefined },
      { counterparty: '', next: null, ends: undefined },
    ]
    expect(columnsWithValues(rows, cells)).toEqual(new Set(['counterparty']))
  })

  it('keeps a column one row fills', () => {
    const rows: Row[] = [
      { counterparty: null, next: null, ends: undefined },
      { counterparty: null, next: '2026-11-30', ends: '2031-02-02' },
    ]
    expect(columnsWithValues(rows, cells)).toEqual(new Set(['next_payment', 'ends']))
  })

  it('counts a zero as a value', () => {
    expect(columnsWithValues([{ amount: 0 }], { amount: (r: { amount: number }) => r.amount })).toEqual(new Set(['amount']))
  })

  it('has no columns without rows', () => {
    expect(columnsWithValues([] as Row[], cells).size).toBe(0)
  })
})
