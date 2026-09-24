/**
 * Tests for /api/salary/premium-rules/[id] (PATCH, DELETE).
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

import { PATCH, DELETE } from '../route'

const EMP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const params = { params: Promise.resolve({ id: 'rule-1' }) } as never

const storedRule = {
  id: 'rule-1',
  company_id: 'company-1',
  name: 'OB natt',
  applies_to_all_employees: true,
  applies_to_employee_ids: [],
  day_of_week: [1, 2, 3, 4, 5, 6, 7],
  start_time: '22:00:00',
  end_time: '06:00:00',
  premium_percent: '70.00',
  item_type: 'ob_night',
  priority: 10,
  is_active: true,
  created_at: '2026-09-11T08:00:00Z',
  updated_at: '2026-09-11T08:00:00Z',
  created_by: 'user-1',
}

function patch(body: unknown) {
  return createMockRequest('/api/salary/premium-rules/rule-1', { method: 'PATCH', body })
}
function del() {
  return createMockRequest('/api/salary/premium-rules/rule-1', { method: 'DELETE' })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('PATCH /api/salary/premium-rules/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await PATCH(patch({ name: 'x' }), params)
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const response = await PATCH(patch({ name: 'x' }), params)
    expect(response.status).toBe(403)
  })

  it('returns 400 on an empty body', async () => {
    const response = await PATCH(patch({}), params)
    expect(response.status).toBe(400)
  })

  it('returns 404 when the rule is not in the company', async () => {
    enqueue({ data: null }) // getShiftPremiumRule
    const response = await PATCH(patch({ name: 'x' }), params)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('SHIFT_PREMIUM_RULE_NOT_FOUND')
  })

  it('rejects a one-field patch that leaves the rule applying to nobody', async () => {
    enqueue({ data: storedRule }) // stored: all employees, no ids
    const response = await PATCH(patch({ applies_to_all_employees: false }), params)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('SHIFT_PREMIUM_RULE_SCOPE_INVALID')
    expect(findCall('shift_premium_rules', 'update')).toBeUndefined()
  })

  it('updates the percent (happy path)', async () => {
    enqueue({ data: storedRule }) // fetch
    enqueue({ data: { ...storedRule, premium_percent: '75.00' } }) // update
    const response = await PATCH(patch({ premium_percent: 75 }), params)
    const { status, body } = await parseJsonResponse<{ data: { premium_percent: number; end_time: string } }>(response)
    expect(status).toBe(200)
    expect(body.data.premium_percent).toBe(75)
    expect(body.data.end_time).toBe('06:00')
    const updated = findCall('shift_premium_rules', 'update')?.[0] as Record<string, unknown>
    expect(updated).toEqual({ premium_percent: 75 })
  })

  it('narrows scope to named employees after verifying them', async () => {
    enqueue({ data: storedRule }) // fetch
    enqueue({ data: [{ id: EMP_A }] }) // employees lookup
    enqueue({
      data: { ...storedRule, applies_to_all_employees: false, applies_to_employee_ids: [EMP_A] },
    })
    const response = await PATCH(
      patch({ applies_to_all_employees: false, applies_to_employee_ids: [EMP_A] }),
      params,
    )
    const { status, body } = await parseJsonResponse<{ data: { applies_to_employee_ids: string[] } }>(response)
    expect(status).toBe(200)
    expect(body.data.applies_to_employee_ids).toEqual([EMP_A])
  })
})

describe('DELETE /api/salary/premium-rules/[id]', () => {
  it('returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })
    const response = await DELETE(del(), params)
    expect(response.status).toBe(403)
  })

  it('returns 404 when nothing was deleted', async () => {
    enqueue({ data: [] })
    const response = await DELETE(del(), params)
    expect(response.status).toBe(404)
  })

  it('deletes the rule (happy path)', async () => {
    enqueue({ data: [{ id: 'rule-1' }] })
    const response = await DELETE(del(), params)
    const { status, body } = await parseJsonResponse<{ data: { id: string; deleted: boolean } }>(response)
    expect(status).toBe(200)
    expect(body.data).toEqual({ id: 'rule-1', deleted: true })
    expect(findCall('shift_premium_rules', 'delete')).toBeDefined()
  })
})
