/**
 * Tests for the dashboard /api/salary/employees/[id]/opening-balances route
 * (the employee page's Ingående saldon panel).
 *
 * Runs the route through the real withRouteContext wrapper; mocks auth,
 * company and write permission and injects a queued Supabase mock. The GET
 * must report the booked-run lock even when no balances row exists yet
 * (crm#1788): otherwise the panel renders an editable form for a save the
 * PUT can only answer with 409.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

// Route path ids are uuids: the route answers its 404 to anything else before it reads.
const EMP_1 = 'fcd49043-9489-5813-aacd-a04b3e121e68'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

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

vi.mock('@/lib/salary/invalidate-calculation', async (original) => ({
  ...(await original<typeof import('@/lib/salary/invalidate-calculation')>()),
  invalidateRunCalculation: vi.fn(async () => null),
}))

import { GET, PUT } from '../route'

const params = { params: Promise.resolve({ id: EMP_1 }) } as never

const CUTOVER_YEAR = new Date().getFullYear()

const STORED_ROW = {
  id: 'ob-1',
  employee_id: EMP_1,
  cutover_date: `${CUTOVER_YEAR}-01-01`,
  ytd_gross: 0,
  ytd_tax: 0,
  ytd_net: 0,
  vacation_paid_days_remaining: 10,
  vacation_days_taken_this_year: 0,
  vacation_saved_days_by_year: {},
  opening_semester_liability: 0,
  opening_semester_liability_avgifter: 0,
  karens_periods_adjustment: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

function get() {
  return createMockRequest(`/api/salary/employees/${EMP_1}/opening-balances`, { method: 'GET' })
}

function put(body: unknown) {
  return createMockRequest(`/api/salary/employees/${EMP_1}/opening-balances`, { method: 'PUT', body })
}

interface GetBody {
  data: { employee_opening_balances_id: string; locked: boolean } | null
  locked: boolean
  locked_by_run_id: string | null
}

describe('GET /api/salary/employees/[id]/opening-balances', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(get(), params)
    expect(response.status).toBe(401)
  })

  it('returns 404 when the employee is not in the company', async () => {
    enqueue({ data: null }) // employee lookup

    const response = await GET(get(), params)
    const { status, body } = await parseJsonResponse<{ code: string }>(response)

    expect(status).toBe(404)
    expect(body.code).toBe('EMPLOYEE_NOT_FOUND')
  })

  it('returns the stored row with its lock state at the top level too (happy path)', async () => {
    enqueue({ data: { id: EMP_1 } }) // employee lookup
    enqueue({ data: STORED_ROW }) // opening balances row
    enqueue({ data: [] }) // booked-run lock lookup: none

    const response = await GET(get(), params)
    const { status, body } = await parseJsonResponse<GetBody>(response)

    expect(status).toBe(200)
    expect(body.data?.employee_opening_balances_id).toBe('ob-1')
    expect(body.data?.locked).toBe(false)
    expect(body.locked).toBe(false)
    expect(body.locked_by_run_id).toBeNull()
  })

  // crm#1788: an employee moved over from another payroll system after the
  // first run here was booked has no row yet, and the form must still know
  // it cannot be saved.
  it('reports the booked-run lock when no balances row exists yet', async () => {
    enqueue({ data: { id: EMP_1 } }) // employee lookup
    enqueue({ data: null }) // no opening balances row
    enqueue({ data: [{ employee_id: EMP_1, salary_run: { id: 'run-1', status: 'booked' } }] })

    const response = await GET(get(), params)
    const { status, body } = await parseJsonResponse<GetBody>(response)

    expect(status).toBe(200)
    expect(body.data).toBeNull()
    expect(body.locked).toBe(true)
    expect(body.locked_by_run_id).toBe('run-1')
    // Scoped to the company and to booked runs: the same lookup the PUT uses.
    expect(findCalls('salary_run_employees', 'eq')).toEqual(
      expect.arrayContaining([
        ['company_id', 'company-1'],
        ['salary_run.status', 'booked'],
      ]),
    )
  })

  it('reports unlocked when no row exists and no run is booked', async () => {
    enqueue({ data: { id: EMP_1 } }) // employee lookup
    enqueue({ data: null }) // no opening balances row
    enqueue({ data: [] }) // no booked runs

    const response = await GET(get(), params)
    const { status, body } = await parseJsonResponse<GetBody>(response)

    expect(status).toBe(200)
    expect(body.data).toBeNull()
    expect(body.locked).toBe(false)
    expect(body.locked_by_run_id).toBeNull()
  })

  it('returns 500 when the lock lookup fails', async () => {
    enqueue({ data: { id: EMP_1 } }) // employee lookup
    enqueue({ data: null }) // no opening balances row
    enqueue({ data: null, error: { message: 'connection failure' } })

    const response = await GET(get(), params)
    expect(response.status).toBe(500)
  })
})

describe('PUT /api/salary/employees/[id]/opening-balances', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 400 for a cutover date that is not the first of a month', async () => {
    const response = await PUT(put({ cutover_date: `${CUTOVER_YEAR}-01-15` }), params)
    expect(response.status).toBe(400)
  })

  // The rule the GET now surfaces up front stays enforced on the write.
  it('keeps answering 409 OPENING_BALANCES_LOCKED when a booked run exists', async () => {
    enqueue({ data: [{ id: EMP_1, employment_start: '2024-01-01', is_active: true }] }) // employees
    enqueue({ data: [{ employee_id: EMP_1, salary_run: { id: 'run-1', status: 'booked' } }] })

    const response = await PUT(put({ cutover_date: `${CUTOVER_YEAR}-01-01` }), params)
    const { status, body } = await parseJsonResponse<{ code: string }>(response)

    expect(status).toBe(409)
    expect(body.code).toBe('OPENING_BALANCES_LOCKED')
    expect(findCalls('employee_opening_balances', 'upsert')).toHaveLength(0)
  })
})
