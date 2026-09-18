import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { rollVacationBalance, VacationBalanceSchema, type VacationBalance } from '../vacation-balance'
import { computeRunVacationBalances } from '../run-vacation-balances'

const opening: VacationBalance = { as_of_date: '2037-07-31', year_start: '2037-01-01', annual_entitlement: 25,
  tracking: true, withdrawals_blocked: false, paid: 8, extra_paid: 2, unpaid: 10, advance: 7, saved_by_year: { '2036': 3.5 },
  source_reference: 'Approved closing statement', review_notes: [] }

describe('categorized vacation balances', () => {
  it('does not deduct July again and keeps future bookings outside the cutoff', () => {
    const movements = [{ date: '2037-07-15', category: 'paid' as const, days: 10 },
      { date: '2037-08-03', category: 'extra_paid' as const, days: 2 },
      { date: '2037-09-15', category: 'paid' as const, days: 1 }]
    expect(rollVacationBalance(opening, movements, '2037-07-31')).toEqual(opening)
    const august = rollVacationBalance(opening, movements, '2037-08-31')
    expect(august.extra_paid).toBe(0)
    expect(august.paid).toBe(8)
    expect(rollVacationBalance(august, movements, '2037-08-31')).toEqual(august)
    expect(opening.extra_paid).toBe(2)
  })
  it('consumes only the specified saved origin year, supporting half days', () => {
    const value = rollVacationBalance(opening, [{ date: '2037-08-05', category: 'saved', saved_year: '2036', days: .5 }], '2037-08-31')
    expect(value.saved_by_year).toEqual({ '2036': 3 })
    expect(value.paid).toBe(8)
  })
  it.each(['paid', 'extra_paid', 'unpaid', 'advance'] as const)('keeps %s distinct and refuses an overdraw', category => {
    expect(rollVacationBalance(opening, [{ date: '2037-08-05', category, days: .5 }], '2037-08-31')[category]).toBe(opening[category] - .5)
    expect(() => rollVacationBalance(opening, [{ date: '2037-08-05', category, days: 30 }], '2037-08-31')).toThrow('Otillräckligt')
  })
  it('rejects missing saving years, backwards cutoffs and implicit year renewal', () => {
    expect(() => rollVacationBalance(opening, [{ date: '2037-08-05', category: 'saved', days: 1 }], '2037-08-31')).toThrow()
    expect(() => rollVacationBalance(opening, [], '2037-07-30')).toThrow()
    expect(() => rollVacationBalance(opening, [], '2038-01-01')).toThrow()
  })
  it('preserves an unresolved source balance but blocks further withdrawals', () => {
    const held = { ...opening, withdrawals_blocked: true }
    expect(rollVacationBalance(held, [], '2037-07-31')).toEqual(held)
    expect(() => rollVacationBalance(held, [{ date: '2037-08-05', category: 'paid', days: 1 }], '2037-08-31')).toThrow('källavstämning')
  })
  it('does not accept negative legacy source balances, impossible dates or excluded balances', () => {
    expect(VacationBalanceSchema.safeParse({ ...opening, saved_by_year: { '2036': -1 } }).success).toBe(false)
    expect(VacationBalanceSchema.safeParse({ ...opening, as_of_date: '2037-02-31' }).success).toBe(false)
    expect(VacationBalanceSchema.safeParse({ ...opening, tracking: false }).success).toBe(false)
  })
})

describe('native run balance snapshots', () => {
  const run = { period_year: 2037, period_month: 8, deviation_period_start: '2037-07-01', deviation_period_end: '2037-07-31' }
  it('keeps the opening cutoff when payroll processes already-consumed leave', async () => {
    const mock = createQueuedMockSupabase(); mock.enqueue({ data: [] })
    const result = await computeRunVacationBalances(mock.supabase as never, { companyId: 'company', runId: 'run', run,
      openings: [{ employee_id: 'e1', vacation_balance: opening }],
      current: [{ employee_id: 'e1', line_items: [{ item_type: 'vacation', quantity: 10 }] }] })
    expect(result.get('e1')).toEqual(opening)
    expect(mock.findCall('salary_run_employees', 'eq')).toEqual(['company_id', 'company'])
  })
  it('fails closed on post-cutover vacation without dated categories', async () => {
    const mock = createQueuedMockSupabase(); mock.enqueue({ data: [] })
    await expect(computeRunVacationBalances(mock.supabase as never, { companyId: 'company', runId: 'run',
      run: { period_year: 2037, period_month: 9, deviation_period_start: '2037-08-01', deviation_period_end: '2037-08-31' },
      openings: [{ employee_id: 'e1', vacation_balance: opening }],
      current: [{ employee_id: 'e1', line_items: [{ item_type: 'vacation', quantity: 5 }] }] })).rejects.toThrow('saknar datum')
  })
  it('includes authorized withdrawals once, excludes future dates and keeps source notes', async () => {
    const mock = createQueuedMockSupabase(); mock.enqueue({ data: [{ employee_id: 'e1', salary_run: run,
      line_items: [{ item_type: 'vacation', quantity: 10, vacation_movements: [{ date: '2037-07-15', category: 'paid', days: 10 }] }] }] })
    const result = await computeRunVacationBalances(mock.supabase as never, { companyId: 'company', runId: 'run',
      run: { period_year: 2037, period_month: 9, deviation_period_start: '2037-08-01', deviation_period_end: '2037-08-31' },
      openings: [{ employee_id: 'e1', vacation_balance: opening }],
      current: [{ employee_id: 'e1', line_items: [{ item_type: 'vacation', quantity: 2, vacation_movements: [
        { date: '2037-08-03', category: 'extra_paid', days: 2 }, { date: '2037-09-15', category: 'paid', days: 1 },
      ] }] }] })
    expect(result.get('e1')).toEqual({ ...opening, as_of_date: '2037-08-31', extra_paid: 0 })
  })
})
