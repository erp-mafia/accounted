/**
 * Auth-wiring and behaviour tests for /api/salary/premium-rules (GET, POST).
 *
 * Runs through the real withRouteContext wrapper; mocks auth/company/write
 * and injects a queued Supabase mock via requireAuth.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()

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

const EMP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMP_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const storedRule = {
  id: 'rule-1',
  company_id: 'company-1',
  name: 'OB kvall',
  applies_to_all_employees: true,
  applies_to_employee_ids: [],
  day_of_week: [5, 1, 2, 3, 4],
  start_time: '18:00:00',
  end_time: '22:00:00',
  premium_percent: '50.00',
  item_type: 'ob_weekday_evening',
  priority: 0,
  is_active: true,
  created_at: '2026-09-11T08:00:00Z',
  updated_at: '2026-09-11T08:00:00Z',
  created_by: 'user-1',
}

const validBody = {
  name: 'OB kvall',
  day_of_week: [1, 2, 3, 4, 5],
  start_time: '18:00',
  end_time: '22:00',
  premium_percent: 50,
  item_type: 'ob_weekday_evening',
}

function get(query = '') {
  return createMockRequest(`/api/salary/premium-rules${query}`, { method: 'GET' })
}
function post(body: unknown) {
  return createMockRequest('/api/salary/premium-rules', { method: 'POST', body })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('GET /api/salary/premium-rules', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await GET(get(), {} as never)
    expect(response.status).toBe(401)
  })

  it('lists active rules with HH:MM times and numeric percent', async () => {
    enqueue({ data: [storedRule] })
    const response = await GET(get(), {} as never)
    const { status, body } = await parseJsonResponse<{ data: Array<Record<string, unknown>> }>(response)
    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].start_time).toBe('18:00')
    expect(body.data[0].end_time).toBe('22:00')
    expect(body.data[0].premium_percent).toBe(50)
    expect(body.data[0].day_of_week).toEqual([1, 2, 3, 4, 5])
    // Default listing is the engine's set: active rules only.
    expect(findCall('shift_premium_rules', 'eq')).toBeDefined()
    const eqCalls = supabase.from.mock.calls.length
    expect(eqCalls).toBe(1)
  })

  it('includes inactive rules on request', async () => {
    enqueue({ data: [{ ...storedRule, is_active: false }] })
    const response = await GET(get('?include_inactive=true'), {} as never)
    const { status, body } = await parseJsonResponse<{ data: Array<Record<string, unknown>> }>(response)
    expect(status).toBe(200)
    expect(body.data[0].is_active).toBe(false)
  })
})

describe('POST /api/salary/premium-rules', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await POST(post(validBody), {} as never)
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const response = await POST(post(validBody), {} as never)
    expect(response.status).toBe(403)
  })

  it('returns 400 on an invalid time', async () => {
    const response = await POST(post({ ...validBody, start_time: '25:00' }), {} as never)
    expect(response.status).toBe(400)
  })

  it('returns 400 when scope is inconsistent (all employees plus named ids)', async () => {
    const response = await POST(
      post({ ...validBody, applies_to_all_employees: true, applies_to_employee_ids: [EMP_A] }),
      {} as never,
    )
    const { status, body } = await parseJsonResponse<{ errors: { field: string }[] }>(response)
    expect(status).toBe(400)
    expect(body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'applies_to_employee_ids' })]),
    )
  })

  it('creates a company-wide rule (happy path, 201)', async () => {
    enqueue({ data: storedRule }) // insert
    const response = await POST(post(validBody), {} as never)
    const { status, body } = await parseJsonResponse<{ data: { id: string; start_time: string } }>(response)
    expect(status).toBe(201)
    expect(body.data.id).toBe('rule-1')
    expect(body.data.start_time).toBe('18:00')
    // No employee lookup for an all-employees rule.
    expect(findCall('employees', 'in')).toBeUndefined()
    const inserted = findCall('shift_premium_rules', 'insert')?.[0] as Record<string, unknown>
    expect(inserted.company_id).toBe('company-1')
    expect(inserted.created_by).toBe('user-1')
    expect(inserted.applies_to_all_employees).toBe(true)
  })

  it('verifies named employees belong to the company and 404s otherwise', async () => {
    enqueue({ data: [{ id: EMP_A }] }) // employees lookup: EMP_B missing
    const response = await POST(
      post({ ...validBody, applies_to_all_employees: false, applies_to_employee_ids: [EMP_A, EMP_B] }),
      {} as never,
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { missing_employee_ids: string[] } }
    }>(response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('SHIFT_PREMIUM_RULE_EMPLOYEE_NOT_FOUND')
    expect(body.error.details?.missing_employee_ids).toEqual([EMP_B])
    expect(findCall('shift_premium_rules', 'insert')).toBeUndefined()
  })

  it('creates a named-employee rule when every id is in the company', async () => {
    enqueue({ data: [{ id: EMP_A }, { id: EMP_B }] }) // employees lookup
    enqueue({
      data: { ...storedRule, applies_to_all_employees: false, applies_to_employee_ids: [EMP_A, EMP_B] },
    })
    const response = await POST(
      post({ ...validBody, applies_to_all_employees: false, applies_to_employee_ids: [EMP_A, EMP_B] }),
      {} as never,
    )
    const { status, body } = await parseJsonResponse<{ data: { applies_to_employee_ids: string[] } }>(response)
    expect(status).toBe(201)
    expect(body.data.applies_to_employee_ids).toEqual([EMP_A, EMP_B])
  })
})
