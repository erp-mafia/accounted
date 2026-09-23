/**
 * Tests for /api/salary/employees/[id]/worked-hours (GET list, POST upsert).
 *
 * Runs the routes through the real withRouteContext wrapper; mocks auth/company/
 * write and injects a recording Supabase mock via requireAuth. Covers 401, 403
 * (viewer), 400, 404 and the happy path, plus the shift-window round trip.
 *
 * The shift-window tests are the point of this file. `start_time` / `end_time`
 * are validated and documented by UpsertWorkedDaySchema, but used to be dropped
 * on the way to the database. A row without times makes the shift-premium engine
 * assume a default 08:00-17:00 day, so OB-tillägg for night and weekend work
 * could never trigger and a night shift was paid as office hours. The last two
 * tests therefore feed the payload the route actually inserts into the real
 * engine and assert the premium appears.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'
import { createRecordingSupabase } from './recording-supabase'
import { computePremiumLines } from '@/lib/salary/shift-premium-engine'
import type { ShiftPremiumRule } from '@/types'

const { supabase, enqueue, reset, insertedRows, selectedColumns, ops } = createRecordingSupabase()

/** The register-lock lookup every write makes right after the employee check. */
const enqueueNoLockingRuns = () => enqueue({ data: [] })

/** July 2026 pay month, calculated, legacy NULL window: locks 2026-07-01..31. */
const REVIEW_RUN_JULY = {
  id: 'run-jul',
  status: 'review',
  period_year: 2026,
  period_month: 7,
  deviation_period_start: null,
  deviation_period_end: null,
}

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { GET, POST } from '../route'

const params = { params: Promise.resolve({ id: 'emp-1' }) } as never

function post(body: unknown) {
  return createMockRequest('/api/salary/employees/emp-1/worked-hours', { method: 'POST', body })
}

function get(searchParams: Record<string, string>) {
  return createMockRequest('/api/salary/employees/emp-1/worked-hours', { searchParams })
}

function makeRule(overrides: Partial<ShiftPremiumRule> = {}): ShiftPremiumRule {
  return {
    id: 'rule-1',
    company_id: 'company-1',
    name: 'OB natt',
    applies_to_all_employees: true,
    applies_to_employee_ids: [],
    day_of_week: [1, 2, 3, 4, 5, 6, 7],
    start_time: '22:00',
    end_time: '06:00',
    premium_percent: 70,
    item_type: 'ob_night',
    priority: 10,
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    created_by: null,
    ...overrides,
  }
}

describe('POST /api/salary/employees/[id]/worked-hours', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(post({ work_date: '2026-07-01', hours: 8 }), params)
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer (no write permission)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await POST(post({ work_date: '2026-07-01', hours: 8 }), params)
    expect(response.status).toBe(403)
  })

  it('returns 400 when only one half of the shift window is given', async () => {
    enqueue({ data: { id: 'emp-1', salary_type: 'hourly' } }) // loadEmployee

    const response = await POST(
      post({ work_date: '2026-07-01', hours: 8, start_time: '22:00' }),
      params,
    )
    expect(response.status).toBe(400)
    // Nothing was written.
    expect(insertedRows()).toHaveLength(0)
  })

  it('upserts a worked day (happy path)', async () => {
    enqueue({ data: { id: 'emp-1', salary_type: 'hourly' } }) // loadEmployee
    enqueueNoLockingRuns()
    enqueue({ data: null }) // delete existing
    enqueue({ data: { id: 'wd-1', work_date: '2026-07-01', hours: 8 } }) // insert

    const response = await POST(post({ work_date: '2026-07-01', hours: 8 }), params)
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(response)

    expect(status).toBe(201)
    expect(body.data.id).toBe('wd-1')
  })

  it('returns 404 when the employee is not in the company', async () => {
    enqueue({ data: null }) // loadEmployee → not found

    const response = await POST(post({ work_date: '2026-07-01', hours: 8 }), params)
    expect(response.status).toBe(404)
  })

  it('returns 409 with the Swedish message and the run when a calculated run already read the date', async () => {
    enqueue({ data: { id: 'emp-1', salary_type: 'hourly' } }) // loadEmployee
    enqueue({ data: [REVIEW_RUN_JULY] }) // register lock lookup

    const response = await POST(post({ work_date: '2026-07-01', hours: 8 }), params)
    const { status, body } = await parseJsonResponse<{
      error: string
      code: string
      details: { salary_run_id: string; locked_dates: string[] }
    }>(response)

    expect(status).toBe(409)
    expect(body.code).toBe('SALARY_REGISTER_DATES_LOCKED_BY_RUN')
    expect(body.error).toContain('avvikelseperioden')
    expect(body.details).toMatchObject({ salary_run_id: 'run-jul', locked_dates: ['2026-07-01'] })
    // Neither the delete nor the insert of the replace ran.
    expect(ops.filter((op) => op.table === 'salary_worked_days')).toHaveLength(0)
    expect(insertedRows()).toHaveLength(0)
  })

  it('writes start_time and end_time to the database', async () => {
    enqueue({ data: { id: 'emp-1', salary_type: 'hourly' } }) // loadEmployee
    enqueueNoLockingRuns()
    enqueue({ data: null }) // delete existing
    enqueue({
      data: {
        id: 'wd-1',
        work_date: '2026-07-01',
        hours: 8,
        start_time: '22:00',
        end_time: '06:00',
      },
    }) // insert

    const response = await POST(
      post({ work_date: '2026-07-01', hours: 8, start_time: '22:00', end_time: '06:00' }),
      params,
    )

    expect(response.status).toBe(201)
    const rows = insertedRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      work_date: '2026-07-01',
      hours: 8,
      start_time: '22:00',
      end_time: '06:00',
    })
  })

  it('stores NULL times when the caller omits the shift window', async () => {
    enqueue({ data: { id: 'emp-1', salary_type: 'hourly' } })
    enqueueNoLockingRuns()
    enqueue({ data: null })
    enqueue({ data: { id: 'wd-1' } })

    await POST(post({ work_date: '2026-07-01', hours: 8 }), params)

    expect(insertedRows()[0]).toMatchObject({ start_time: null, end_time: null })
  })

  it('makes a night shift trigger OB natt (regression: times used to be dropped)', async () => {
    // Wednesday 2026-07-01, 22:00 -> 06:00. A pure-night OB rule (22:00-06:00)
    // has zero overlap with the engine's 08:00-17:00 fallback, so before the
    // times were persisted this employee got no OB-tillägg at all.
    enqueue({ data: { id: 'emp-1', salary_type: 'hourly' } })
    enqueueNoLockingRuns()
    enqueue({ data: null })
    enqueue({ data: { id: 'wd-1' } })

    await POST(
      post({ work_date: '2026-07-01', hours: 8, start_time: '22:00', end_time: '06:00' }),
      params,
    )

    const inserted = insertedRows()[0]
    const lines = computePremiumLines({
      employeeId: 'emp-1',
      baseHourlyRate: 200,
      workedDays: [
        {
          work_date: inserted.work_date as string,
          hours: inserted.hours as number,
          start_time: inserted.start_time as string | null,
          end_time: inserted.end_time as string | null,
        },
      ],
      rules: [makeRule()],
    })

    expect(lines).toHaveLength(1)
    expect(lines[0].itemType).toBe('ob_night')
    // 22:00-24:00 plus 00:00-06:00 = 8 h at 70 % of 200 SEK/h.
    expect(lines[0].hours).toBe(8)
    expect(lines[0].amount).toBe(1120)
  })

  it('prices a Saturday evening shift on its real hours, not the fabricated day', async () => {
    // Saturday 2026-07-04, 18:00 -> 23:00 = 5 h. With a full-day weekend rule the
    // 08:00-17:00 fallback would have billed 9 h of the wrong hours instead.
    enqueue({ data: { id: 'emp-1', salary_type: 'hourly' } })
    enqueueNoLockingRuns()
    enqueue({ data: null })
    enqueue({ data: { id: 'wd-1' } })

    await POST(
      post({ work_date: '2026-07-04', hours: 5, start_time: '18:00', end_time: '23:00' }),
      params,
    )

    const inserted = insertedRows()[0]
    const lines = computePremiumLines({
      employeeId: 'emp-1',
      baseHourlyRate: 200,
      workedDays: [
        {
          work_date: inserted.work_date as string,
          hours: inserted.hours as number,
          start_time: inserted.start_time as string | null,
          end_time: inserted.end_time as string | null,
        },
      ],
      rules: [
        makeRule({
          id: 'rule-weekend',
          name: 'OB helg',
          item_type: 'ob_weekend',
          day_of_week: [6, 7],
          start_time: '00:00',
          end_time: '00:00', // full 24 h on Saturday and Sunday
          premium_percent: 100,
        }),
      ],
    })

    expect(lines).toHaveLength(1)
    expect(lines[0].itemType).toBe('ob_weekend')
    expect(lines[0].hours).toBe(5)
    expect(lines[0].amount).toBe(1000)
  })
})

describe('GET /api/salary/employees/[id]/worked-hours', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(get({ from: '2026-07-01', to: '2026-07-31' }), params)
    expect(response.status).toBe(401)
  })

  it('returns 404 when the employee is not in the company', async () => {
    enqueue({ data: null }) // loadEmployee → not found

    const response = await GET(get({ from: '2026-07-01', to: '2026-07-31' }), params)
    expect(response.status).toBe(404)
  })

  it('returns 400 when the range is inverted', async () => {
    enqueue({ data: { id: 'emp-1', salary_type: 'hourly' } }) // loadEmployee

    const response = await GET(get({ from: '2026-07-31', to: '2026-07-01' }), params)
    expect(response.status).toBe(400)
  })

  it('selects the shift window back and returns it', async () => {
    enqueue({ data: { id: 'emp-1', salary_type: 'hourly' } }) // loadEmployee
    enqueue({
      data: [
        {
          id: 'wd-1',
          work_date: '2026-07-01',
          hours: 8,
          notes: null,
          salary_run_employee_id: null,
          start_time: '22:00:00',
          end_time: '06:00:00',
          created_at: '2026-07-01T00:00:00Z',
          updated_at: '2026-07-01T00:00:00Z',
        },
      ],
    })

    const response = await GET(get({ from: '2026-07-01', to: '2026-07-31' }), params)
    const { status, body } = await parseJsonResponse<{
      data: Array<{ start_time: string | null; end_time: string | null }>
      total_hours: number
    }>(response)

    expect(status).toBe(200)
    // The read path has to ask for the columns, otherwise the round trip is
    // silently lossy no matter what the write path stored.
    const readColumns = selectedColumns().find((cols) => cols?.includes('work_date'))
    expect(readColumns).toContain('start_time')
    expect(readColumns).toContain('end_time')
    expect(body.data[0].start_time).toBe('22:00:00')
    expect(body.data[0].end_time).toBe('06:00:00')
    expect(body.total_hours).toBe(8)
  })
})
