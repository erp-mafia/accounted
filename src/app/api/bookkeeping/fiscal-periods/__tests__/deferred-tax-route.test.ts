/**
 * Tests for GET/PUT /api/bookkeeping/fiscal-periods/{id}/deferred-tax
 * (cookie session, withRouteContext). The deferred tax service and the
 * dispositions builder are mocked; the wrapper is real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

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

const saveMock = vi.fn()
const loadMock = vi.fn()
const movementsMock = vi.fn()
vi.mock('@/lib/bokslut/tax-provision/deferred-tax-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bokslut/tax-provision/deferred-tax-service')>(
    '@/lib/bokslut/tax-provision/deferred-tax-service',
  )
  return {
    ...actual,
    saveDeferredTaxAssessment: (...args: unknown[]) => saveMock(...args),
    loadDeferredTaxAssessment: (...args: unknown[]) => loadMock(...args),
    deferredTaxMovements: (...args: unknown[]) => movementsMock(...args),
  }
})
const buildMock = vi.fn()
vi.mock('@/lib/bokslut/dispositions-proposal-builder', () => ({
  buildDispositionsProposal: (...args: unknown[]) => buildMock(...args),
}))

import { DeferredTaxNotApplicableError } from '@/lib/bokslut/tax-provision/deferred-tax-service'
import { GET, PUT } from '../[id]/deferred-tax/route'

const p = (id: string) => ({ params: Promise.resolve({ id }) }) as never
const OPEN = { id: 'fy-2026', is_closed: false, locked_at: null, closing_entry_id: null }
const BODY = { loss_recognised: true, loss_reason: 'Ny storkund ger överskott.', manual_items: [] }

describe('deferred tax route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    saveMock.mockResolvedValue(BODY)
    loadMock.mockResolvedValue(BODY)
    movementsMock.mockResolvedValue({ liability: { opening: 0, change: 0, closing: 0 }, asset: { opening: 0, change: 0, closing: 0 }, byKind: [] })
    buildMock.mockResolvedValue({ proposals: [] })
  })

  it('401 without a session', async () => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const res = await PUT(createMockRequest('http://localhost/x', { method: 'PUT', body: BODY }), p('fy-2026'))
    expect(res.status).toBe(401)
    expect(saveMock).not.toHaveBeenCalled()
  })

  it('400 when a recognised loss has no reason', async () => {
    const res = await PUT(
      createMockRequest('http://localhost/x', { method: 'PUT', body: { loss_recognised: true, manual_items: [] } }),
      p('fy-2026'),
    )
    expect(res.status).toBe(400)
    expect(saveMock).not.toHaveBeenCalled()
  })

  it('404 for a period of another company', async () => {
    enqueue({ data: null })
    const res = await PUT(createMockRequest('http://localhost/x', { method: 'PUT', body: BODY }), p('nope'))
    expect(res.status).toBe(404)
  })

  it('saves the inputs and answers the recalculated dispositions', async () => {
    enqueue({ data: OPEN })
    const { status, body } = await parseJsonResponse<{ data: unknown }>(
      await PUT(createMockRequest('http://localhost/x', { method: 'PUT', body: BODY }), p('fy-2026')),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual({ proposals: [] })
    expect(saveMock).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', 'fy-2026', BODY)
  })

  it('422 in a K2 year, and refuses a locked year', async () => {
    enqueue({ data: OPEN })
    saveMock.mockRejectedValue(new DeferredTaxNotApplicableError())
    expect((await PUT(createMockRequest('http://localhost/x', { method: 'PUT', body: BODY }), p('fy-2026'))).status).toBe(422)
    enqueue({ data: { ...OPEN, locked_at: '2027-02-01T00:00:00Z' } })
    // PERIOD_LOCKED is a 400 in the error catalogue.
    expect((await PUT(createMockRequest('http://localhost/x', { method: 'PUT', body: BODY }), p('fy-2026'))).status).toBe(400)
  })

  it('reads the inputs and the year\'s movements', async () => {
    enqueue({ data: OPEN })
    const { status, body } = await parseJsonResponse<{ data: { assessment: unknown } }>(
      await GET(createMockRequest('http://localhost/x'), p('fy-2026')),
    )
    expect(status).toBe(200)
    expect(body.data.assessment).toEqual(BODY)
  })
})
