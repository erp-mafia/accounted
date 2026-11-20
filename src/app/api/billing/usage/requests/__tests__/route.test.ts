import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'

const state = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof import('@/tests/helpers').createTableMockSupabase> }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(state.db.supabase),
  createServiceClient: () => state.db.supabase,
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: (...args: unknown[]) => requireWriteMock(...args) }))
const requestMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/usage/requests', () => ({ requestMoreUsage: (...args: unknown[]) => requestMock(...args) }))

import { requireAuth } from '@/lib/auth/require-auth'
import { POST } from '../route'

const user = { id: 'user-1', email: 'anna@bygg.se' }
type ErrorBody = { error: { code: string } }

const post = (body: unknown) => POST(createMockRequest('/api/billing/usage/requests', { method: 'POST', body }), createMockRouteParams({}))

beforeEach(() => {
  vi.clearAllMocks()
  state.db = createTableMockSupabase({})
  vi.mocked(requireAuth).mockResolvedValue({ user: user as never, supabase: state.db.supabase as never, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
  requestMock.mockResolvedValue({ ok: true, created: true, data: { request_id: 'r-1', created_at: '2026-11-14T10:00:00.000Z' } })
})

describe('POST /api/billing/usage/requests', () => {
  it('is 401 without a session and asks for nothing', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ user: null as never, supabase: state.db.supabase as never, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await post({ kind: 'signing' })).status).toBe(401)
    expect(requestMock).not.toHaveBeenCalled()
  })

  it.each([
    ['no kind', {}],
    ['an unknown kind', { kind: 'fax' }],
    ['a message that is too long', { kind: 'signing', message: 'x'.repeat(2001) }],
    ['bank payments, which ask through their own request', { kind: 'bank_payment' }],
    ['a kind with no charge to open', { kind: 'billo_send' }],
    ['a kind that is only counted', { kind: 'ai_document' }],
  ])('is 400 for %s', async (_name, body) => {
    expect((await post(body)).status).toBe(400)
    expect(requestMock).not.toHaveBeenCalled()
  })

  it('is 201 with the request, from the person who asked', async () => {
    const { status, body } = await parseJsonResponse(await post({ kind: 'bank_account', message: '  Tre konton till  ' }))
    expect(status).toBe(201)
    expect(body).toEqual({ data: { request_id: 'r-1', created_at: '2026-11-14T10:00:00.000Z' } })
    expect(requestMock).toHaveBeenCalledWith(
      state.db.supabase,
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1', email: 'anna@bygg.se' }),
      { kind: 'bank_account', message: 'Tre konton till' },
    )
  })

  it('is 409 USAGE_REQUEST_OPEN while an unanswered request is younger than a day', async () => {
    requestMock.mockResolvedValue({ ok: false, code: 'USAGE_REQUEST_OPEN', details: { requested_at: '2026-11-14T08:00:00.000Z' } })
    const { status, body } = await parseJsonResponse<ErrorBody>(await post({ kind: 'signing' }))
    expect(status).toBe(409)
    expect(body.error.code).toBe('USAGE_REQUEST_OPEN')
  })

  it('is refused for a session that may not write', async () => {
    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    expect((await post({ kind: 'signing' })).status).toBe(403)
    expect(requestMock).not.toHaveBeenCalled()
  })
})
