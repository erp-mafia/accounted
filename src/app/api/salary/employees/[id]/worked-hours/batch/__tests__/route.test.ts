/**
 * Tests for /api/salary/employees/[id]/worked-hours/batch (POST).
 *
 * Runs the route through the real withRouteContext wrapper; mocks auth/company/
 * write and injects a recording Supabase mock via requireAuth. Covers 401, 403
 * (viewer), 400, 404 and the happy path.
 *
 * The rest of the file guards the per-date upsert. The batch carries one
 * shared body for N dates, so anything it omits (per-day notes, per-day shift
 * windows, per-day run links) has to survive. It used to write the shared
 * value or NULL over every day, which wiped notes the user had written and
 * shift windows that made OB-tillägg computable. It also used to delete every
 * date first and reinsert, with restore code for a refused date; an upsert
 * the database refuses changes nothing, so there is nothing to restore.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'
import { createRecordingSupabase } from '../../__tests__/recording-supabase'

const { supabase, enqueue, reset, insertedRows, ops } = createRecordingSupabase()

/** Payloads of every upsert of a worked day, in call order. */
const writtenRows = () =>
  ops.filter((op) => op.table === 'salary_worked_days' && op.verb === 'upsert').map((op) => op.payload!)

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

import { POST } from '../route'
import { invalidateRunCalculation } from '@/lib/salary/invalidate-calculation'

// The step every input write takes has its own suite (invalidate-calculation.test.ts).
vi.mock('@/lib/salary/invalidate-calculation', async (original) => ({
  ...(await original<typeof import('@/lib/salary/invalidate-calculation')>()),
  invalidateRunCalculation: vi.fn(async () => null),
}))

const params = { params: Promise.resolve({ id: 'emp-1' }) } as never

function post(body: unknown) {
  return createMockRequest('/api/salary/employees/emp-1/worked-hours/batch', {
    method: 'POST',
    body,
  })
}

const validBatch = { dates: ['2026-07-01', '2026-07-02'], hours: 8 }

/** Queue the reads the route does before its writes: employee, register lock, prefetch. */
function enqueuePreamble(existing: unknown[] = []) {
  enqueue({ data: { id: 'emp-1' } }) // employee ownership check
  enqueue({ data: [] }) // register lock lookup: no locking runs
  enqueue({ data: existing.map((row) => ({ work_date: (row as { work_date: string }).work_date, carried_to_run_id: null })) }) // register lock: the days already registered
  enqueue({ data: existing }) // prefetch of the rows the batch overwrites
}

/** July 2026 pay month, calculated, legacy NULL window: locks 2026-07-01..31. */
const REVIEW_RUN_JULY = {
  id: 'run-jul',
  status: 'review',
  period_year: 2026,
  period_month: 7,
  deviation_period_start: null,
  deviation_period_end: null,
}

describe('POST /api/salary/employees/[id]/worked-hours/batch', () => {
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

    const response = await POST(post(validBatch), params)
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer (no write permission)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await POST(post(validBatch), params)
    expect(response.status).toBe(403)
  })

  it('returns 400 for an empty date list', async () => {
    enqueue({ data: { id: 'emp-1' } }) // employee ownership check

    const response = await POST(post({ dates: [], hours: 8 }), params)
    expect(response.status).toBe(400)
    expect(writtenRows()).toHaveLength(0)
  })

  it('returns 400 when only one half of the shift window is given', async () => {
    enqueue({ data: { id: 'emp-1' } }) // employee ownership check

    const response = await POST(post({ ...validBatch, end_time: '06:00' }), params)
    expect(response.status).toBe(400)
    expect(insertedRows()).toHaveLength(0)
  })

  it('writes every date (happy path)', async () => {
    enqueuePreamble()
    enqueue({ data: null }) // upsert date 1
    enqueue({ data: null }) // upsert date 2

    const response = await POST(post(validBatch), params)
    const { status, body } = await parseJsonResponse<{
      data: { inserted: number; conflicts: unknown[] }
    }>(response)

    expect(status).toBe(201)
    expect(body.data.inserted).toBe(2)
    expect(body.data.conflicts).toEqual([])
  })

  it('takes one scheduled day of the employee when the hours are left out, and clears the calculation', async () => {
    enqueue({ data: { id: 'emp-1', hours_per_week: 40, workdays_per_week: 4 } }) // employee ownership check
    enqueue({ data: [] }) // register lock lookup: no locking runs
    enqueue({ data: [] }) // register lock: nothing registered on the days
    enqueue({ data: [] }) // prefetch
    enqueue({ data: null }) // upsert date 1
    enqueue({ data: null }) // upsert date 2

    const response = await POST(post({ dates: ['2026-07-02', '2026-07-01'] }), params)

    expect(response.status).toBe(201)
    expect(writtenRows().map((row) => row.hours)).toEqual([10, 10])
    expect(invalidateRunCalculation).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      employeeId: 'emp-1',
      workedDays: { from: '2026-07-01', to: '2026-07-02' },
    })
  })

  it('returns 404 when the employee is not in the company', async () => {
    enqueue({ data: null }) // employee ownership check → not found

    const response = await POST(post(validBatch), params)
    expect(response.status).toBe(404)
  })

  it('returns 409 with the Swedish message and the run when a calculated run already read a date, touching nothing', async () => {
    enqueue({ data: { id: 'emp-1' } }) // employee ownership check
    enqueue({ data: [REVIEW_RUN_JULY] }) // register lock lookup
    enqueue({ data: [] }) // nothing registered on the days

    const response = await POST(post(validBatch), params)
    const { status, body } = await parseJsonResponse<{
      error: string
      code: string
      details: { salary_run_id: string; locked_dates: string[] }
    }>(response)

    expect(status).toBe(409)
    expect(body.code).toBe('SALARY_REGISTER_DATES_LOCKED_BY_RUN')
    expect(body.error).toContain('Återställ den till utkast')
    expect(body.details).toMatchObject({
      salary_run_id: 'run-jul',
      locked_dates: ['2026-07-01', '2026-07-02'],
    })
    // No prefetch, no bulk delete, no insert: the lock is checked first,
    // and reads only the days' carry.
    expect(ops.filter((op) => op.table === 'salary_worked_days').map((op) => op.columns)).toEqual([
      'work_date, carried_to_run_id',
    ])
    expect(insertedRows()).toHaveLength(0)
  })

  it('keeps each day its own note when the batch carries none', async () => {
    enqueuePreamble([
      {
        work_date: '2026-07-01',
        notes: 'Inventering lager',
        salary_run_employee_id: null,
        start_time: null,
        end_time: null,
      },
      {
        work_date: '2026-07-02',
        notes: 'Kundbesök Göteborg',
        salary_run_employee_id: null,
        start_time: null,
        end_time: null,
      },
    ])
    enqueue({ data: null })
    enqueue({ data: null })

    const response = await POST(post(validBatch), params)
    expect(response.status).toBe(201)

    const rows = writtenRows()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ work_date: '2026-07-01', notes: 'Inventering lager' })
    expect(rows[1]).toMatchObject({ work_date: '2026-07-02', notes: 'Kundbesök Göteborg' })
  })

  it('lets an explicit batch note override the stored per-day notes', async () => {
    enqueuePreamble([
      {
        work_date: '2026-07-01',
        notes: 'Inventering lager',
        salary_run_employee_id: null,
        start_time: null,
        end_time: null,
      },
    ])
    enqueue({ data: null })
    enqueue({ data: null })

    await POST(post({ ...validBatch, notes: 'Projektvecka' }), params)

    const rows = writtenRows()
    expect(rows[0]).toMatchObject({ work_date: '2026-07-01', notes: 'Projektvecka' })
    expect(rows[1]).toMatchObject({ work_date: '2026-07-02', notes: 'Projektvecka' })
  })

  it('writes the shift window when the batch supplies one', async () => {
    enqueuePreamble()
    enqueue({ data: null })
    enqueue({ data: null })

    await POST(post({ ...validBatch, start_time: '22:00', end_time: '06:00' }), params)

    for (const row of writtenRows()) {
      expect(row).toMatchObject({ start_time: '22:00', end_time: '06:00' })
    }
  })

  it('keeps a stored shift window when the batch supplies none', async () => {
    // Re-marking hours must not silently erase the times: that would send the
    // day back to the engine's 08:00-17:00 fallback and drop the OB-tillägg.
    enqueuePreamble([
      {
        work_date: '2026-07-01',
        notes: null,
        salary_run_employee_id: null,
        start_time: '22:00:00',
        end_time: '06:00:00',
      },
    ])
    enqueue({ data: null })
    enqueue({ data: null })

    await POST(post(validBatch), params)

    const rows = writtenRows()
    expect(rows[0]).toMatchObject({ start_time: '22:00:00', end_time: '06:00:00' })
    // The untouched day has no stored window, so it stays NULL.
    expect(rows[1]).toMatchObject({ start_time: null, end_time: null })
  })

  it('keeps a stored salary_run_employee_id when the batch supplies none', async () => {
    enqueuePreamble([
      {
        work_date: '2026-07-01',
        notes: null,
        salary_run_employee_id: 'sre-1',
        start_time: null,
        end_time: null,
      },
    ])
    enqueue({ data: null })
    enqueue({ data: null })

    await POST(post(validBatch), params)

    const rows = writtenRows()
    expect(rows[0]).toMatchObject({ salary_run_employee_id: 'sre-1' })
    expect(rows[1]).toMatchObject({ salary_run_employee_id: null })
  })

  it('reads the existing rows first, then upserts each date and never deletes', async () => {
    enqueuePreamble()
    enqueue({ data: null })
    enqueue({ data: null })

    await POST(post(validBatch), params)

    // The register lock reads the days' carry, then the prefetch the rest.
    const workedDayOps = ops.filter((op) => op.table === 'salary_worked_days')
    expect(workedDayOps[0].columns).toBe('work_date, carried_to_run_id')
    expect(workedDayOps[1].verb).toBe('select')
    expect(workedDayOps[1].columns).toContain('notes')
    expect(workedDayOps[1].columns).toContain('start_time')
    expect(workedDayOps.slice(2).map((op) => op.verb)).toEqual(['upsert', 'upsert'])
    expect(workedDayOps.some((op) => op.verb === 'delete')).toBe(false)
  })

  it('reports a date the 24h cap refuses as a conflict and leaves its stored row alone', async () => {
    // A refused upsert changes nothing: the stored row keeps its hours,
    // notes and shift window without any restore write.
    enqueuePreamble([
      {
        work_date: '2026-07-01',
        notes: 'Halvdag',
        salary_run_employee_id: 'sre-1',
        start_time: '08:00:00',
        end_time: '13:00:00',
      },
    ])
    enqueue({ error: { message: 'Total tid över 24h', code: '23514' } }) // upsert date 1 trips the cap
    enqueue({ data: null }) // upsert date 2

    const response = await POST(post(validBatch), params)
    const { status, body } = await parseJsonResponse<{
      data: { inserted: number; conflicts: { date: string }[] }
    }>(response)

    expect(status).toBe(207)
    expect(body.data.inserted).toBe(1)
    expect(body.data.conflicts).toHaveLength(1)
    expect(body.data.conflicts[0].date).toBe('2026-07-01')
    // The refused attempt and date 2: no third write puts anything back.
    expect(writtenRows()).toHaveLength(2)
    expect(writtenRows()[1]).toMatchObject({ work_date: '2026-07-02', hours: 8 })
  })

  it('stops at an unexpected error, leaving the dates after it untouched', async () => {
    const threeDates = { dates: ['2026-07-01', '2026-07-02', '2026-07-03'], hours: 8 }
    enqueuePreamble([])
    enqueue({ data: null }) // upsert date 1: ok
    enqueue({ error: { message: 'connection reset', code: '08006' } }) // upsert date 2: unexpected

    const response = await POST(post(threeDates), params)
    const { status, body } = await parseJsonResponse<{ inserted: number }>(response)

    expect(status).toBe(500)
    expect(body.inserted).toBe(1)
    // Date 3 was never written, and nothing was deleted to put back.
    expect(writtenRows().map((r) => r.work_date)).toEqual(['2026-07-01', '2026-07-02'])
    expect(insertedRows()).toHaveLength(0)
  })

  it('aborts without writing anything when the prefetch fails', async () => {
    enqueue({ data: { id: 'emp-1' } }) // employee ownership check
    enqueue({ data: [] }) // register lock lookup: no locking runs
    enqueue({ error: { message: 'connection reset', code: '08006' } }) // prefetch fails

    const response = await POST(post(validBatch), params)

    expect(response.status).toBe(500)
    expect(writtenRows()).toHaveLength(0)
    // The only salary_worked_days query issued was the failed read.
    const workedDayOps = ops.filter((op) => op.table === 'salary_worked_days')
    expect(workedDayOps).toHaveLength(1)
    expect(workedDayOps[0].verb).toBe('select')
  })
})

describe('POST /api/salary/employees/[id]/worked-hours/batch: late hours', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it("carries hours on a booked run's dates, registered from a draft payslip, to that payslip's run", async () => {
    enqueue({ data: { id: 'emp-1' } }) // employee ownership check
    enqueue({ data: { salary_run_id: 'run-aug' } }) // the payslip's run
    enqueue({
      data: [
        { ...REVIEW_RUN_JULY, status: 'booked', agi_submitted_at: null, corrects_run_id: null },
        {
          id: 'run-aug',
          status: 'draft',
          period_year: 2026,
          period_month: 8,
          deviation_period_start: null,
          deviation_period_end: null,
          agi_submitted_at: null,
          corrects_run_id: null,
        },
      ],
    }) // runs
    enqueue({ data: [] }) // nothing registered on the days
    enqueue({ data: [{ salary_run_id: 'run-aug', salary_type: 'hourly' }] }) // the employee is on August
    enqueue({ data: [] }) // prefetch
    enqueue({ data: null }) // upsert date 1
    enqueue({ data: null }) // upsert date 2

    const response = await POST(
      post({ ...validBatch, salary_run_employee_id: '11111111-1111-4111-8111-111111111111' }),
      params,
    )

    expect(response.status).toBe(201)
    expect(writtenRows().map((row) => row.carried_to_run_id)).toEqual(['run-aug', 'run-aug'])
  })
})
