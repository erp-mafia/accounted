/**
 * Auth-wiring tests for /api/salary/employees/[id]/benefits/[benefitId]
 * (PATCH/DELETE). Runs through the real withRouteContext wrapper; mocks auth/
 * company/write and injects a queued Supabase mock via requireAuth. Covers 401,
 * 403 (viewer), the DELETE outcomes (hard delete, deactivate when a payslip
 * line derives from the row, 404 when nothing matched: #2695), and the
 * validity-period contract on PATCH
 * (CHECK (valid_to IS NULL OR valid_to >= valid_from), migration
 * 20260512200100), including the error-mapping split that used to report a
 * check_violation as 404 "Förmån hittades inte".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()

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

import { DELETE, PATCH } from '../route'

const params = { params: Promise.resolve({ id: 'emp-1', benefitId: 'ben-1' }) } as never

function del() {
  return createMockRequest('/api/salary/employees/emp-1/benefits/ben-1', { method: 'DELETE' })
}

function patch(body: unknown) {
  return createMockRequest('/api/salary/employees/emp-1/benefits/ben-1', { method: 'PATCH', body })
}

/** Stored row as the PATCH route fetches it before writing. */
const storedBenefit = {
  benefit_type: 'other',
  metadata: {},
  valid_from: '2026-06-01',
  valid_to: '2026-12-31',
}

describe('DELETE /api/salary/employees/[id]/benefits/[benefitId]', () => {
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

    const response = await DELETE(del(), params)
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer (no write permission)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await DELETE(del(), params)
    expect(response.status).toBe(403)
  })

  it('hard-deletes a benefit no payslip line derives from (happy path)', async () => {
    enqueue({ data: null, count: 0 }) // salary_line_items referencing count
    enqueue({ data: [{ id: 'ben-1' }] }) // delete ... returning id

    const response = await DELETE(del(), params)
    const { status, body } = await parseJsonResponse<{
      data: { id: string; deleted: boolean; deactivated: boolean }
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual({ id: 'ben-1', deleted: true, deactivated: false })
    expect(findCall('employee_benefits', 'delete')).toBeDefined()
    expect(findCall('employee_benefits', 'update')).toBeUndefined()
  })

  // #2695: salary_line_items.source_benefit_id is ON DELETE SET NULL, so a
  // hard delete would turn the derived line into a manual-looking one that
  // step 8d of the calculation never removes. The row is kept and switched
  // off instead; the next recalculation drops the line by its intact link.
  it('keeps and deactivates a benefit that a payslip line derives from', async () => {
    enqueue({ data: null, count: 1 }) // one derived line points at the row
    enqueue({ data: [{ id: 'ben-1' }] }) // update ... returning id

    const response = await DELETE(del(), params)
    const { status, body } = await parseJsonResponse<{
      data: { id: string; deleted: boolean; deactivated: boolean }
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual({ id: 'ben-1', deleted: false, deactivated: true })
    expect(findCall('employee_benefits', 'delete')).toBeUndefined()
    expect(findCall('employee_benefits', 'update')).toEqual([{ is_active: false }])
    // The update is scoped to the row on this employee in this company.
    expect(findCalls('employee_benefits', 'eq')).toEqual(
      expect.arrayContaining([
        ['id', 'ben-1'],
        ['employee_id', 'emp-1'],
        ['company_id', 'company-1'],
      ]),
    )
  })

  it('returns 404 when no benefit matched on the employee', async () => {
    enqueue({ data: null, count: 0 })
    enqueue({ data: [] }) // delete matched nothing

    const response = await DELETE(del(), params)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect(body.error).toBe('Förmån hittades inte')
  })

  it('maps a failure on the referencing-line count to 500, not a delete', async () => {
    enqueue({ data: null, error: { code: '08006', message: 'connection failure' } })

    const response = await DELETE(del(), params)

    expect(response.status).toBe(500)
    expect(findCall('employee_benefits', 'delete')).toBeUndefined()
    expect(findCall('employee_benefits', 'update')).toBeUndefined()
  })
})

describe('PATCH /api/salary/employees/[id]/benefits/[benefitId]', () => {
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

    const response = await PATCH(patch({ monthly_value: 100 }), params)
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer (no write permission)', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const response = await PATCH(patch({ monthly_value: 100 }), params)
    expect(response.status).toBe(403)
  })

  it('updates the benefit (happy path)', async () => {
    enqueue({ data: storedBenefit }) // existence check
    enqueue({ data: { id: 'ben-1', monthly_value: 100 } }) // update

    const response = await PATCH(patch({ monthly_value: 100 }), params)
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(response)

    expect(status).toBe(200)
    expect(body.data.id).toBe('ben-1')
  })

  it('returns 404 when the benefit does not exist in the company', async () => {
    enqueue({ data: null, error: { code: 'PGRST116', message: 'no rows' } })

    const response = await PATCH(patch({ monthly_value: 100 }), params)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect(body.error).toBe('Förmån hittades inte')
  })

  describe('valid_from / valid_to ordering', () => {
    // Both dates in the body: the schema can compare them itself, so this 400
    // lands before any DB call.
    it('rejects both-dates-in-body with valid_to before valid_from', async () => {
      const response = await PATCH(
        patch({ valid_from: '2026-06-01', valid_to: '2026-05-31' }),
        params,
      )
      const { status, body } = await parseJsonResponse<{
        error: string
        errors: { field: string }[]
      }>(response)

      expect(status).toBe(400)
      expect(body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'valid_to' })]),
      )
      expect(body.error).toContain('Gäller till')
      expect(supabase.from).not.toHaveBeenCalled()
    })

    // Single-field PATCH: the schema cannot see the stored half, so the route
    // compares the merged pair against the fetched row and answers 400 itself.
    // This is the case that used to reach Postgres and return 404.
    it('rejects a valid_to-only patch that predates the stored valid_from', async () => {
      enqueue({ data: storedBenefit }) // stored valid_from 2026-06-01

      const response = await PATCH(patch({ valid_to: '2026-05-31' }), params)
      const { status, body } = await parseJsonResponse<{ error: string }>(response)

      expect(status).toBe(400)
      expect(body.error).toContain('Gäller till')
      expect(body.error).not.toContain('hittades inte')
      // Fetched once, never written.
      expect(supabase.from).toHaveBeenCalledTimes(1)
    })

    it('rejects a valid_from-only patch that postdates the stored valid_to', async () => {
      enqueue({ data: storedBenefit }) // stored valid_to 2026-12-31

      const response = await PATCH(patch({ valid_from: '2027-01-01' }), params)
      expect(response.status).toBe(400)
      expect(supabase.from).toHaveBeenCalledTimes(1)
    })

    it('accepts a valid_to-only patch that is still on or after the stored valid_from', async () => {
      enqueue({ data: storedBenefit })
      enqueue({ data: { id: 'ben-1', valid_to: '2026-06-01' } })

      // Equal to the stored valid_from: legal, the bound is inclusive.
      const response = await PATCH(patch({ valid_to: '2026-06-01' }), params)
      expect(response.status).toBe(200)
    })

    it('accepts both dates equal (the bound is inclusive)', async () => {
      enqueue({ data: storedBenefit })
      enqueue({ data: { id: 'ben-1' } })

      const response = await PATCH(
        patch({ valid_from: '2026-06-01', valid_to: '2026-06-01' }),
        params,
      )
      expect(response.status).toBe(200)
    })

    it('accepts valid_to: null (clearing the end date keeps the benefit open-ended)', async () => {
      enqueue({ data: storedBenefit })
      enqueue({ data: { id: 'ben-1', valid_to: null } })

      const response = await PATCH(patch({ valid_to: null }), params)
      expect(response.status).toBe(200)
    })

    it('accepts a valid_from-only patch when the stored valid_to is null', async () => {
      enqueue({ data: { ...storedBenefit, valid_to: null } })
      enqueue({ data: { id: 'ben-1' } })

      const response = await PATCH(patch({ valid_from: '2030-01-01' }), params)
      expect(response.status).toBe(200)
    })
  })

  describe('write-error mapping (not "hittades inte")', () => {
    it('maps a check_violation on the update to 400 with the period message', async () => {
      enqueue({ data: storedBenefit })
      enqueue({
        data: null,
        error: { code: '23514', message: 'violates check constraint "employee_benefits_check"' },
      })

      const response = await PATCH(patch({ monthly_value: 100 }), params)
      const { status, body } = await parseJsonResponse<{ error: string }>(response)

      expect(status).toBe(400)
      expect(body.error).toContain('Gäller till')
      expect(body.error).not.toContain('hittades inte')
    })

    it('maps a real DB failure on the update to 500, not 404', async () => {
      enqueue({ data: storedBenefit })
      enqueue({ data: null, error: { code: '08006', message: 'connection failure' } })

      const response = await PATCH(patch({ monthly_value: 100 }), params)
      const { status, body } = await parseJsonResponse<{ error: string }>(response)

      expect(status).toBe(500)
      expect(body.error).not.toContain('hittades inte')
    })

    it('keeps 404 when the row disappears between the fetch and the update', async () => {
      enqueue({ data: storedBenefit })
      enqueue({ data: null, error: { code: 'PGRST116', message: 'no rows' } })

      const response = await PATCH(patch({ monthly_value: 100 }), params)
      const { status, body } = await parseJsonResponse<{ error: string }>(response)

      expect(status).toBe(404)
      expect(body.error).toBe('Förmån hittades inte')
    })

    it('maps a failed existence lookup (non-PGRST116) to 500, not 404', async () => {
      enqueue({ data: null, error: { code: '08006', message: 'connection failure' } })

      const response = await PATCH(patch({ monthly_value: 100 }), params)
      const { status, body } = await parseJsonResponse<{ error: string }>(response)

      expect(status).toBe(500)
      expect(body.error).not.toContain('hittades inte')
    })
  })
})
