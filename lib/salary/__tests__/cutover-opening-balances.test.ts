import { afterAll, describe, it, expect, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { OpeningBalancesItemSchema } from '@/lib/api/schemas'
import { setOpeningBalancesBulk } from '../opening-balances'
import type { VacationBalance } from '../vacation-balance'

vi.useFakeTimers()
vi.setSystemTime(new Date('2037-09-01T12:00:00Z'))
afterAll(() => vi.useRealTimers())

const balance: VacationBalance = { as_of_date: '2037-07-31', year_start: '2037-01-01', annual_entitlement: 25,
  tracking: true, withdrawals_blocked: false, paid: 8, extra_paid: 2, unpaid: 10, advance: 7, saved_by_year: { '2036': 3.5 }, source_reference: 'Synthetic closing balance', review_notes: [] }
const employee = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const item = OpeningBalancesItemSchema.parse({ employee_id: employee, cutover_date: '2037-08-01',
  vacation_paid_days_remaining: 10, vacation_saved_days_by_year: { '2036': 3.5 } })

describe('cutover opening command safety', () => {
  it('accepts only an explicit zero start-month opening before a mid-month hire', async () => {
    for (const gross of [0, 100]) {
      const mock = createQueuedMockSupabase()
      mock.enqueue({ data: [{ id: employee, employment_start: '2037-08-10', is_active: true }] })
      mock.enqueue({ data: [] })
      mock.enqueue({ data: [] })
      const result = await setOpeningBalancesBulk(mock.supabase as never, { companyId: 'company', userId: 'user', dryRun: true,
        items: [{ ...item, ytd_gross: gross, ytd_tax: 0, ytd_net: 0, opening_semester_liability: 0, opening_semester_liability_avgifter: 0,
          vacation_saved_days_by_year: {}, vacation_balance: { ...balance, as_of_date: '2037-08-10', saved_by_year: {} } }] })
      expect(result.ok).toBe(gross === 0)
    }
  })
  it('defaults unavailable net and liability amounts to unknown, not zero', () => {
    expect(item.ytd_net).toBeNull()
    expect(item.opening_semester_liability).toBeNull()
    expect(item.opening_semester_liability_avgifter).toBeNull()
  })
  it('preserves categorized balances omitted by an older caller and dry-run writes nothing', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [{ id: employee, employment_start: '2037-01-01', is_active: true }] })
    mock.enqueue({ data: [] })
    mock.enqueue({ data: [{ employee_id: employee, created_by: 'owner', vacation_balance: balance }] })
    const result = await setOpeningBalancesBulk(mock.supabase as never, { companyId: 'company', userId: 'user', items: [item], dryRun: true })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.rows[0].vacation_balance).toEqual(balance)
    expect(mock.findCall('employee_opening_balances', 'upsert')).toBeUndefined()
  })
  it('rejects conflicting legacy edits during dry-run as well as real writes', async () => {
    for (const dryRun of [true, false]) {
      const mock = createQueuedMockSupabase()
      mock.enqueue({ data: [{ id: employee, employment_start: '2037-01-01', is_active: true }] })
      mock.enqueue({ data: [] })
      mock.enqueue({ data: [{ employee_id: employee, vacation_balance: balance }] })
      const result = await setOpeningBalancesBulk(mock.supabase as never, { companyId: 'company', userId: 'user', items: [{ ...item, vacation_paid_days_remaining: 25 }], dryRun })
      expect(result.ok).toBe(false)
      expect(mock.findCall('employee_opening_balances', 'upsert')).toBeUndefined()
    }
  })
})
