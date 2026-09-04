/**
 * Auth-wiring tests for /api/salary/employees/[id]/recurring-lines/[lineId]
 * (PATCH update, DELETE remove). Runs the routes through the real
 * withRouteContext wrapper; mocks auth/company/write and injects a queued
 * Supabase mock via requireAuth.
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

const params = { params: Promise.resolve({ id: 'emp-1', lineId: 'line-1' }) } as never

function patch(body: unknown) {
  return createMockRequest('/api/salary/employees/emp-1/recurring-lines/line-1', {
    method: 'PATCH',
    body,
  })
}

const storedLine = {
  item_type: 'gross_deduction_other',
  valid_from: '2026-01-01',
  valid_to: null,
}

describe('PATCH /api/salary/employees/[id]/recurring-lines/[lineId]', () => {
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

    const response = await PATCH(patch({ amount: -700 }), params)
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer (no write permission)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await PATCH(patch({ amount: -700 }), params)
    expect(response.status).toBe(403)
  })

  it('updates the amount (happy path)', async () => {
    enqueue({ data: storedLine }) // fetch existing
    enqueue({ data: { id: 'line-1', amount: -700 } }) // update

    const response = await PATCH(patch({ amount: -700 }), params)
    const { status, body } = await parseJsonResponse<{ data: { amount: number } }>(response)

    expect(status).toBe(200)
    expect(body.data.amount).toBe(-700)
  })

  it('writes exactly the patchable columns and nothing else', async () => {
    // Scoped assertion for the merged-updates payload: it is assembled
    // conditionally, so the phantom-column scanner cannot resolve it. This
    // pins the column set the route can ever write.
    enqueue({ data: storedLine }) // fetch existing
    enqueue({ data: { id: 'line-1' } }) // update

    await PATCH(
      patch({
        description: 'Förmånscykel',
        amount: -700,
        account_number: '7399',
        valid_from: '2026-02-01',
        valid_to: '2026-12-31',
        metadata: { source: 'test' },
        is_active: false,
      }),
      params,
    )

    const update = findCall('employee_recurring_lines', 'update')
    expect(Object.keys(update?.[0] as Record<string, unknown>).sort()).toEqual([
      'account_number',
      'amount',
      'description',
      'is_active',
      'metadata',
      'valid_from',
      'valid_to',
    ])
  })

  it('returns 404 when the line does not exist', async () => {
    enqueue({ data: null, error: { code: 'PGRST116', message: 'zero rows' } })

    const response = await PATCH(patch({ amount: -700 }), params)
    expect(response.status).toBe(404)
  })

  it('rejects an amount whose sign contradicts the stored item_type', async () => {
    enqueue({ data: storedLine }) // fetch existing: a gross deduction

    const response = await PATCH(patch({ amount: 700 }), params)
    expect(response.status).toBe(400)
  })

  it('rejects a merged period where the patched valid_to lands before the stored valid_from', async () => {
    enqueue({ data: { ...storedLine, valid_from: '2026-06-01' } })

    const response = await PATCH(patch({ valid_to: '2026-05-31' }), params)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toContain('Gäller till')
  })

  it('maps a check_violation on the write to 400, not 404', async () => {
    enqueue({ data: storedLine })
    enqueue({ data: null, error: { code: '23514', message: 'violates check constraint' } })

    const response = await PATCH(patch({ valid_from: '2026-02-01' }), params)
    expect(response.status).toBe(400)
  })

  it('reports a transport failure on the fetch as 500, not 404', async () => {
    enqueue({ data: null, error: { code: '08006', message: 'connection failure' } })

    const response = await PATCH(patch({ amount: -700 }), params)
    expect(response.status).toBe(500)
  })
})

describe('DELETE /api/salary/employees/[id]/recurring-lines/[lineId]', () => {
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

    const request = createMockRequest('/api/salary/employees/emp-1/recurring-lines/line-1', {
      method: 'DELETE',
    })
    const response = await DELETE(request, params)
    expect(response.status).toBe(401)
  })

  it('hard-deletes a line that has never been derived into a run', async () => {
    enqueue({ data: { id: 'line-1' } }) // delete returns the removed row

    const request = createMockRequest('/api/salary/employees/emp-1/recurring-lines/line-1', {
      method: 'DELETE',
    })
    const response = await DELETE(request, params)
    const { status, body } = await parseJsonResponse<{ data: { deleted: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data.deleted).toBe(true)
  })

  it('returns 404 when the delete matches no row', async () => {
    // Unknown id, or a line belonging to another company: the filtered
    // delete reports no error and no row.
    enqueue({ data: null })

    const request = createMockRequest('/api/salary/employees/emp-1/recurring-lines/nope', {
      method: 'DELETE',
    })
    const response = await DELETE(request, {
      params: Promise.resolve({ id: 'emp-1', lineId: 'nope' }),
    } as never)
    expect(response.status).toBe(404)
  })

  it('deactivates instead of deleting when derived rows reference the line', async () => {
    // The FK is NO ACTION: the delete itself fails with 23503 and the route
    // falls back to deactivation, race-free by construction.
    enqueue({ error: { code: '23503', message: 'violates foreign key constraint' } })
    enqueue({ data: null }) // is_active=false update resolves

    const request = createMockRequest('/api/salary/employees/emp-1/recurring-lines/line-1', {
      method: 'DELETE',
    })
    const response = await DELETE(request, params)
    const { status, body } = await parseJsonResponse<{
      data: { deleted: boolean; deactivated?: boolean }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.deleted).toBe(false)
    expect(body.data.deactivated).toBe(true)
  })
})
