import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockSupabase } from '@/tests/helpers'

const authState = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
}))

const requireWriteMock = vi.hoisted(() => vi.fn())
const isAdminMock = vi.hoisted(() => vi.fn())

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

// The real envelope builder stays: only the database predicate is mocked.
vi.mock('@/lib/auth/require-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/require-write')>()
  return {
    requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
    isCompanyAdmin: (...args: unknown[]) => isAdminMock(...args),
    companyAdminRequiredResponse: actual.companyAdminRequiredResponse,
  }
})

const supabaseRef = vi.hoisted(() => ({ supabase: null as unknown }))

import { withRouteContext } from '../with-route-context'
import { getActiveCompanyId } from '@/lib/company/context'
import { getActor } from '@/lib/bookkeeping/actor-context'

const EMPTY_PARAMS = { params: Promise.resolve({}) }

describe('withRouteContext', () => {
  // Every commit a handler makes, however deep, reads this scope: the
  // verifikat records the signed-in user as its actor.
  it('runs the handler as the signed-in user, and only the handler', async () => {
    let seen: ReturnType<typeof getActor>
    const route = withRouteContext('test.actor', async () => {
      await Promise.resolve()
      seen = getActor()
      return NextResponse.json({ ok: true })
    })

    await route(new Request('http://localhost/api/test', { method: 'POST' }), EMPTY_PARAMS)

    // The user's id rides along: the audit log names them for the handler's
    // service-role writes (lib/supabase/actor-header.ts).
    expect(seen).toEqual({ type: 'user', userId: 'user-1' })
    expect(getActor()).toBeUndefined()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    authState.user = { id: 'user-1' }
    supabaseRef.supabase = createMockSupabase().supabase
    vi.mocked(getActiveCompanyId).mockResolvedValue('company-1')
    requireWriteMock.mockResolvedValue({ ok: true })
    isAdminMock.mockResolvedValue(true)
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

  it('hands the role the resolver reported to the write guard and to the handler', async () => {
    vi.mocked(getActiveCompanyId).mockImplementation(async (_supabase, _userId, facts) => {
      if (facts) facts.role = 'member'
      return 'company-1'
    })
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))
    const route = withRouteContext('test.write', handler, { requireWrite: true })

    const res = await route(new Request('http://localhost/api/test', { method: 'POST' }), EMPTY_PARAMS)

    expect(res.status).toBe(200)
    expect(requireWriteMock).toHaveBeenCalledWith(supabaseRef.supabase, 'user-1', {
      companyId: 'company-1',
      role: 'member',
    })
    expect(handler).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ companyId: 'company-1', role: 'member' }),
      EMPTY_PARAMS,
    )
  })

  it('leaves the role unknown when the resolver did not report one', async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))
    const route = withRouteContext('test.read', handler)

    await route(new Request('http://localhost/api/test'), EMPTY_PARAMS)

    const ctx = (handler.mock.calls[0] as unknown[])[1] as { role?: string }
    expect(ctx.role).toBeUndefined()
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

  it('asks the owner/admin predicate for the resolved company on requireAdmin routes, instead of the write guard', async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))
    const route = withRouteContext('test.admin', handler, { requireAdmin: true })

    const res = await route(new Request('http://localhost/api/test', { method: 'PATCH' }), EMPTY_PARAMS)

    expect(res.status).toBe(200)
    expect(isAdminMock).toHaveBeenCalledTimes(1)
    expect(isAdminMock).toHaveBeenCalledWith(supabaseRef.supabase, 'company-1')
    // Owner and admin are non-viewer roles: the write guard would be a
    // second round trip that can only agree.
    expect(requireWriteMock).not.toHaveBeenCalled()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('answers the canonical 403 envelope with a request id and skips the handler when the predicate says no', async () => {
    isAdminMock.mockResolvedValue(false)
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))
    const route = withRouteContext('test.admin', handler, { requireAdmin: true, requireWrite: true })

    const res = await route(new Request('http://localhost/api/test', { method: 'PATCH' }), EMPTY_PARAMS)

    expect(res.status).toBe(403)
    expect(res.headers.get('X-Request-Id')).toMatch(/^req_/)
    const body = await res.json() as { error: { code: string; message: string; details: { required_roles: string[] } } }
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.message).toBe('Bara företagets ägare eller en administratör kan göra det här.')
    expect(body.error.details.required_roles).toEqual(['owner', 'admin'])
    expect(handler).not.toHaveBeenCalled()
    expect(requireWriteMock).not.toHaveBeenCalled()
  })

  it('answers 500, not 403, when the admin predicate cannot be evaluated', async () => {
    isAdminMock.mockRejectedValue(new Error('rpc unavailable'))
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))
    const route = withRouteContext('test.admin', handler, { requireAdmin: true })

    const res = await route(new Request('http://localhost/api/test', { method: 'PATCH' }), EMPTY_PARAMS)

    expect(res.status).toBe(500)
    expect(handler).not.toHaveBeenCalled()
  })

  it('never asks the admin predicate on routes that did not opt in', async () => {
    const route = withRouteContext('test.write', async () => NextResponse.json({ ok: true }), {
      requireWrite: true,
    })

    await route(new Request('http://localhost/api/test', { method: 'POST' }), EMPTY_PARAMS)

    expect(isAdminMock).not.toHaveBeenCalled()
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

  it('keeps the phases in the op-completed log but off the response in production', async () => {
    const logLines = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      // A self-hosted production server: NODE_ENV alone decides. (It also
      // turns the logger's info lines on; the test env keeps them quiet.)
      vi.stubEnv('VERCEL_ENV', undefined)
      vi.stubEnv('NODE_ENV', 'production')
      vi.stubEnv('EXPOSE_TIMING_HEADERS', undefined)
      const route = withRouteContext('test.read', async () => NextResponse.json({ ok: true }))

      const res = await route(new Request('http://localhost/api/test'), EMPTY_PARAMS)

      expect(res.status).toBe(200)
      expect(res.headers.get('Server-Timing')).toBeNull()
      const completed = logLines.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes('"op completed"'))
      expect(completed).toBeDefined()
      expect(completed).toMatch(/"authMs":\d+/)
      expect(completed).toMatch(/"handlerMs":\d+/)

      vi.stubEnv('EXPOSE_TIMING_HEADERS', 'true')
      const optedIn = await route(new Request('http://localhost/api/test'), EMPTY_PARAMS)
      expect(optedIn.headers.get('Server-Timing')).toMatch(/^auth;dur=\d+/)
    } finally {
      vi.unstubAllEnvs()
      logLines.mockRestore()
    }
  })

  it('refuses an export before building it while an import is unfinished', async () => {
    const { supabase } = createMockSupabase()
    supabase.rpc.mockResolvedValue({ data: null, error: { code: '55000', message: 'SIE_IMPORT_HOLD' } })
    supabaseRef.supabase = supabase
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))
    const route = withRouteContext('report.test.pdf', handler, { requireCompleteLedger: true })
    const res = await route(new Request('http://localhost/api/test'), EMPTY_PARAMS)
    expect(res.status).toBe(409)
    expect(handler).not.toHaveBeenCalled()
  })

  it('holds an export through generation and validates its lease before returning it', async () => {
    const { supabase } = createMockSupabase()
    supabase.rpc.mockResolvedValueOnce({ data: 'lease-1', error: null })
      .mockResolvedValueOnce({ data: null, error: null })
    supabaseRef.supabase = supabase
    const handler = vi.fn(async () => {
      expect(supabase.rpc).toHaveBeenCalledTimes(1)
      return new NextResponse('file', { headers: { 'Content-Disposition': 'attachment' } })
    })
    const route = withRouteContext('report.test.pdf', handler, { requireCompleteLedger: true })
    const res = await route(new Request('http://localhost/api/test'), EMPTY_PARAMS)
    expect(await res.text()).toBe('file')
    expect(supabase.rpc).toHaveBeenLastCalledWith('finish_sie_period_read', {
      p_company_id: 'company-1', p_token: 'lease-1', p_require_valid: true,
    })
  })

  it('keeps on-screen JSON available when the same route also downloads a filing', async () => {
    const { supabase } = createMockSupabase()
    supabaseRef.supabase = supabase
    const route = withRouteContext('report.test', async () => NextResponse.json({ data: [] }), {
      requireCompleteLedger: request => new URL(request.url).searchParams.get('format') === 'sru',
    })
    const res = await route(new Request('http://localhost/api/test?format=json'), EMPTY_PARAMS)
    expect(res.status).toBe(200)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  describe('the tab company check', () => {
    const post = (headers: Record<string, string>, path = '/api/test', method = 'POST') =>
      new Request(`http://localhost${path}`, { method, headers })

    it('runs a write whose tab company matches the active company', async () => {
      const handler = vi.fn(async () => NextResponse.json({ ok: true }))
      const route = withRouteContext('test.tab', handler)

      const res = await route(post({ 'x-tab-company-id': 'company-1' }), EMPTY_PARAMS)

      expect(res.status).toBe(200)
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('refuses a write for another company with ACTIVE_COMPANY_CHANGED and runs nothing', async () => {
      const handler = vi.fn(async () => NextResponse.json({ ok: true }))
      const route = withRouteContext('test.tab', handler, { requireWrite: true })

      const res = await route(post({ 'x-tab-company-id': 'company-2' }), EMPTY_PARAMS)
      const body = (await res.json()) as { error: { code: string; requestId?: string } }

      expect(res.status).toBe(409)
      expect(body.error.code).toBe('ACTIVE_COMPANY_CHANGED')
      expect(body.error.requestId).toMatch(/^req_/)
      expect(res.headers.get('x-active-company-id')).toBe('company-1')
      expect(handler).not.toHaveBeenCalled()
      expect(requireWriteMock).not.toHaveBeenCalled()
    })

    it('runs a write without the header', async () => {
      const handler = vi.fn(async () => NextResponse.json({ ok: true }))
      const route = withRouteContext('test.tab', handler)

      const res = await route(post({}), EMPTY_PARAMS)

      expect(res.status).toBe(200)
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('runs a GET that names another company', async () => {
      const handler = vi.fn(async () => NextResponse.json({ ok: true }))
      const route = withRouteContext('test.tab', handler)

      const res = await route(post({ 'x-tab-company-id': 'company-2' }, '/api/test', 'GET'), EMPTY_PARAMS)

      expect(res.status).toBe(200)
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('never refuses the company switch', async () => {
      const handler = vi.fn(async () => NextResponse.json({ ok: true }))
      const route = withRouteContext('company.switch', handler)

      const res = await route(post({ 'x-tab-company-id': 'company-2' }, '/api/company/switch'), EMPTY_PARAMS)

      expect(res.status).toBe(200)
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('answers an unauthenticated request without naming a company', async () => {
      authState.user = null
      const route = withRouteContext('test.tab', async () => NextResponse.json({ ok: true }))

      const res = await route(post({ 'x-tab-company-id': 'company-2' }), EMPTY_PARAMS)

      expect(res.status).toBe(401)
      expect(res.headers.get('x-active-company-id')).toBeNull()
    })
  })

  describe('the active company header', () => {
    it('names the company on the handler response', async () => {
      const route = withRouteContext('test.header', async () => NextResponse.json({ ok: true }))

      const res = await route(new Request('http://localhost/api/test'), EMPTY_PARAMS)

      expect(res.headers.get('x-active-company-id')).toBe('company-1')
    })

    it('names the company on a thrown error answer', async () => {
      const route = withRouteContext('test.header', async () => {
        throw new Error('boom')
      })

      const res = await route(new Request('http://localhost/api/test'), EMPTY_PARAMS)

      expect(res.status).toBe(500)
      expect(res.headers.get('x-active-company-id')).toBe('company-1')
    })

    it('names the company on a refusal after it is resolved', async () => {
      requireWriteMock.mockResolvedValue({
        ok: false,
        response: NextResponse.json({ error: { code: 'FORBIDDEN' } }, { status: 403 }),
      })
      const route = withRouteContext('test.header', async () => NextResponse.json({ ok: true }), {
        requireWrite: true,
      })

      const res = await route(new Request('http://localhost/api/test', { method: 'POST' }), EMPTY_PARAMS)

      expect(res.status).toBe(403)
      expect(res.headers.get('x-active-company-id')).toBe('company-1')
    })

    it('rebuilds a response that refuses the header, keeping status, headers and body', async () => {
      const route = withRouteContext('test.header', async () => {
        const upstream = new Response('streamed', { status: 202, headers: { 'X-Upstream': 'yes' } })
        const set = upstream.headers.set.bind(upstream.headers)
        vi.spyOn(upstream.headers, 'set').mockImplementation((name: string, value: string) => {
          if (name.toLowerCase() === 'x-active-company-id') throw new TypeError('immutable')
          set(name, value)
        })
        return upstream
      })

      const res = await route(new Request('http://localhost/api/test'), EMPTY_PARAMS)

      expect(res.status).toBe(202)
      expect(res.headers.get('x-upstream')).toBe('yes')
      expect(res.headers.get('x-active-company-id')).toBe('company-1')
      expect(await res.text()).toBe('streamed')
    })
  })
})
