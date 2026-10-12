/**
 * readVacationBalance (lib/salary/vacation-balance.ts): the one read behind
 * the v1 vacation-balance route and the MCP tool gnubok_get_vacation_balance.
 */
import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { readVacationBalance } from '../vacation-balance'

const ARGS = { companyId: 'company-1', employeeId: 'emp-1' }
const EMPLOYEE = {
  id: 'emp-1',
  vacation_rule: 'procentregeln',
  vacation_days_per_year: 25,
  vacation_pay_rate: null,
  semestertillagg_rate: 0.0043,
  salary_type: 'monthly',
  monthly_salary: 30000,
  employment_degree: 100,
  hourly_rate: null,
  hours_per_week: 40,
  workdays_per_week: 5,
}
const BALANCE = {
  id: 'bal-1',
  employee_id: 'emp-1',
  vacation_year_start: '2026-04-01',
  entitled_days: 25,
  accrued_days: 12.5,
  taken_days: 10,
  saved_days: { '2024': 3, '2025': 5 },
  saved_days_taken: { '2024': 1 },
  forced_payout_days: 0,
  unpaid_days: null,
  advance_days: null,
}

describe('readVacationBalance', () => {
  it('answers remaining days, the sparade dagar still held and their total, and a SEK estimate', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: EMPLOYEE }, { data: BALANCE }])

    const result = await readVacationBalance(supabase as never, ARGS)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.remaining_days).toBe(15)
      expect(result.data.saved_days).toEqual({ '2024': 2, '2025': 5 })
      expect(result.data.saved_days_total).toBe(7)
      expect(result.data.unpaid_days).toBe(0)
      expect(result.data.advance_days).toBe(0)
      expect(result.data.estimated_liability_sek).toBeGreaterThan(0)
    }
  })

  it('floors the estimate at zero for an overdrawn balance', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: EMPLOYEE }, { data: { ...BALANCE, taken_days: 40, saved_days: {}, saved_days_taken: {} } }])

    const result = await readVacationBalance(supabase as never, ARGS)

    expect(result.ok && result.data.estimated_liability_sek).toBe(0)
  })

  it('tells a wrong employee from a missing ledger row', async () => {
    const wrong = createQueuedMockSupabase()
    wrong.enqueue({ data: null })
    expect(await readVacationBalance(wrong.supabase as never, ARGS)).toEqual({ ok: false, code: 'EMPLOYEE_NOT_FOUND' })

    const unseeded = createQueuedMockSupabase()
    unseeded.enqueueMany([{ data: EMPLOYEE }, { data: null }])
    expect(await readVacationBalance(unseeded.supabase as never, ARGS)).toEqual({
      ok: false,
      code: 'VACATION_BALANCE_NOT_FOUND',
    })
  })
})
