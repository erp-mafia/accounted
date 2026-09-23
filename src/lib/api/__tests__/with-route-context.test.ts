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

const EMPTY_PARAMS = { params: Promise.resolve({}) }

describe('withRouteContext', () => {
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
})
