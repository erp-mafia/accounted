/**
 * lib/salary/list-runs.ts: the salary-run list behind the v1 route
 * GET /salary-runs and the MCP tool gnubok_list_salary_runs. The filters,
 * the oldest-first keyset order and the next_cursor contract are what both
 * doors rely on.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { encodeDefaultCursor } from '@/lib/api/v1/pagination'
import { listSalaryRuns, SalaryRunListFiltersSchema } from '../list-runs'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function run(n: number) {
  return {
    id: `0000000${n}-cccc-4ccc-8ccc-cccccccccccc`,
    period_year: 2026,
    period_month: n,
    payment_date: `2026-0${n}-25`,
    deviation_period_start: null,
    deviation_period_end: null,
    status: 'booked',
    voucher_series: 'L',
    total_gross: 35000,
    total_tax: 8200,
    total_net: 26800,
    total_avgifter: 10997,
    total_employer_cost: 45997,
    agi_generated_at: null,
    agi_submitted_at: null,
    approved_at: null,
    paid_at: null,
    booked_at: null,
    created_at: `2026-0${n}-01T08:00:00Z`,
  }
}

let mock: ReturnType<typeof createTableMockSupabase>
let ctx: { supabase: SupabaseClient; companyId: string }

beforeEach(() => {
  mock = createTableMockSupabase()
  ctx = { supabase: mock.supabase as unknown as SupabaseClient, companyId: COMPANY_ID }
})

describe('listSalaryRuns', () => {
  it('scopes to the company, orders oldest first and fetches one row past the page', async () => {
    mock.setTable('salary_runs', { data: [run(1)] })

    const result = await listSalaryRuns(ctx, { limit: 10 })

    expect(result).toEqual({ ok: true, data: { runs: [run(1)], next_cursor: null } })
    expect(mock.findCalls('salary_runs', 'eq')).toEqual([['company_id', COMPANY_ID]])
    expect(mock.findCalls('salary_runs', 'order')).toEqual([
      ['created_at', { ascending: true }],
      ['id', { ascending: true }],
    ])
    expect(mock.findCall('salary_runs', 'limit')).toEqual([11])
  })

  it('applies the year, month and status filters', async () => {
    mock.setTable('salary_runs', { data: [] })

    await listSalaryRuns(ctx, { periodYear: 2026, periodMonth: 9, status: 'draft' })

    expect(mock.findCalls('salary_runs', 'eq')).toEqual([
      ['company_id', COMPANY_ID],
      ['period_year', 2026],
      ['period_month', 9],
      ['status', 'draft'],
    ])
  })

  it('defaults to a page of 50', async () => {
    mock.setTable('salary_runs', { data: [] })
    await listSalaryRuns(ctx, {})
    expect(mock.findCall('salary_runs', 'limit')).toEqual([51])
  })

  it('trims to the page and points next_cursor at its last row when more remain', async () => {
    mock.setTable('salary_runs', { data: [run(1), run(2), run(3)] })

    const result = await listSalaryRuns(ctx, { limit: 2 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.runs.map((r) => r.id)).toEqual([run(1).id, run(2).id])
    expect(result.data.next_cursor).toBe(encodeDefaultCursor(run(2)))
  })

  it('continues after the cursor with a strict keyset predicate', async () => {
    mock.setTable('salary_runs', { data: [run(3)] })
    const cursor = encodeDefaultCursor(run(2))

    await listSalaryRuns(ctx, { cursor, limit: 2 })

    expect(mock.findCall('salary_runs', 'or')).toEqual([
      `created_at.gt.${run(2).created_at},and(created_at.eq.${run(2).created_at},id.gt.${run(2).id})`,
    ])
  })

  it('starts from the first page when the cursor does not decode', async () => {
    mock.setTable('salary_runs', { data: [] })
    await listSalaryRuns(ctx, { cursor: 'not-a-cursor' })
    expect(mock.findCall('salary_runs', 'or')).toBeUndefined()
  })

  it('hands a database error to the door', async () => {
    const dbError = { code: '57014', message: 'canceling statement due to statement timeout' }
    mock.setTable('salary_runs', { error: dbError })

    const result = await listSalaryRuns(ctx, {})

    expect(result).toEqual({ ok: false, code: 'UNKNOWN_ERROR', error: dbError })
  })
})

describe('SalaryRunListFiltersSchema', () => {
  it('coerces a query-string year and accepts every status', () => {
    expect(SalaryRunListFiltersSchema.parse({ period_year: '2026', status: 'corrected' })).toEqual({
      period_year: 2026,
      status: 'corrected',
    })
  })

  it('refuses a year out of range and an unknown status', () => {
    expect(SalaryRunListFiltersSchema.safeParse({ period_year: 1999 }).success).toBe(false)
    expect(SalaryRunListFiltersSchema.safeParse({ status: 'cancelled' }).success).toBe(false)
  })
})
