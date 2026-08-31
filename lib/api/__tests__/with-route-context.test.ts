import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockSupabase } from '@/tests/helpers'

const authState = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
}))

const requireWriteMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(async () => {
    if (!authState.user) {
      return { error: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
    }
    return { user: authState.user, supabase: supabaseRef.supabase }
  }),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn(),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

const supabaseRef = vi.hoisted(() => ({ supabase: null as unknown }))

import { withRouteContext } from '../with-route-context'
import { getActiveCompanyId } from '@/lib/company/context'

const EMPTY_PARAMS = { params: Promise.resolve({}) }

describe('withRouteContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authState.user = { id: 'user-1' }
    supabaseRef.supabase = createMockSupabase().supabase
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('resolves the company once and hands it to the write guard on write routes', async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))
    const route = withRouteContext('test.write', handler, { requireWrite: true })

    const res = await route(new Request('http://localhost/api/test', { method: 'POST' }), EMPTY_PARAMS)

    expect(res.status).toBe(200)
    expect(getActiveCompanyId).toHaveBeenCalledTimes(1)
    expect(requireWriteMock).toHaveBeenCalledTimes(1)
    expect(requireWriteMock).toHaveBeenCalledWith(supabaseRef.supabase, 'user-1', {
      companyId: 'company-1',
    })
    expect(handler).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ companyId: 'company-1', user: { id: 'user-1' } }),
      EMPTY_PARAMS,
    )
  })

  it('never invokes the write guard on read routes', async () => {
    const route = withRouteContext('test.read', async () => NextResponse.json({ ok: true }))

    const res = await route(new Request('http://localhost/api/test'), EMPTY_PARAMS)

    expect(res.status).toBe(200)
    expect(getActiveCompanyId).toHaveBeenCalledTimes(1)
    expect(requireWriteMock).not.toHaveBeenCalled()
  })

  it('passes the guard 403 through with a request id and skips the handler', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'viewer' }, { status: 403 }),
    })
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))
    const route = withRouteContext('test.write', handler, { requireWrite: true })

    const res = await route(new Request('http://localhost/api/test', { method: 'POST' }), EMPTY_PARAMS)

    expect(res.status).toBe(403)
    expect(res.headers.get('X-Request-Id')).toMatch(/^req_/)
    expect(handler).not.toHaveBeenCalled()
  })

  it('returns COMPANY_CONTEXT_MISSING before the guard when no company resolves', async () => {
    vi.mocked(getActiveCompanyId).mockResolvedValue(null)
    const route = withRouteContext('test.write', async () => NextResponse.json({ ok: true }), {
      requireWrite: true,
    })

    const res = await route(new Request('http://localhost/api/test', { method: 'POST' }), EMPTY_PARAMS)

    expect(res.status).toBe(400)
    expect(requireWriteMock).not.toHaveBeenCalled()
  })

  it('returns 401 from requireAuth untouched except for the request id', async () => {
    authState.user = null
    const route = withRouteContext('test.read', async () => NextResponse.json({ ok: true }))

    const res = await route(new Request('http://localhost/api/test'), EMPTY_PARAMS)

    expect(res.status).toBe(401)
    expect(res.headers.get('X-Request-Id')).toMatch(/^req_/)
    expect(getActiveCompanyId).not.toHaveBeenCalled()
  })

  it('emits a Server-Timing header with the auth, company and handler phases', async () => {
    const route = withRouteContext('test.read', async () => NextResponse.json({ ok: true }))

    const res = await route(new Request('http://localhost/api/test'), EMPTY_PARAMS)

    expect(res.headers.get('Server-Timing')).toMatch(
      /^auth;dur=\d+, company;dur=\d+, handler;dur=\d+$/,
    )
  })
})
