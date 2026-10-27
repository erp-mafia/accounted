import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createMockSupabase, parseJsonResponse } from '@/tests/helpers'
import type { ActiveCompanyFacts } from '@/lib/company/active-company'
import type { CompanyRole } from '@/types'

const state = vi.hoisted(() => ({
  supabase: null as unknown,
  role: 'invoicer' as CompanyRole | undefined,
  scoped: { scoped: true } as unknown,
}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(async () => ({ user: { id: 'user-1' }, supabase: state.supabase })),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn(async (_supabase: unknown, _userId: string, facts?: ActiveCompanyFacts) => {
    if (facts && state.role) facts.role = state.role
    return 'company-1'
  }),
}))

vi.mock('@/lib/auth/require-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/require-write')>()
  return { ...actual, requireWritePermission: vi.fn(async () => ({ ok: true })) }
})

vi.mock('@/lib/auth/company-scoped-client', () => ({
  createCompanyScopedClient: vi.fn(() => state.scoped),
}))

import { withRouteContext } from '../with-route-context'
import { createCompanyScopedClient } from '@/lib/auth/company-scoped-client'

const PARAMS = { params: Promise.resolve({}) }
const ID = '7f3c2a10-1b2c-4d5e-8f90-123456789abc'

function routeSeeingClient() {
  const seen: { supabase?: SupabaseClient } = {}
  const handler = vi.fn(async (_req: Request, ctx: { supabase: SupabaseClient }) => {
    seen.supabase = ctx.supabase
    return NextResponse.json({ ok: true })
  })
  return { route: withRouteContext('test.invoicer', handler), handler, seen }
}

describe('withRouteContext: the invoicer role', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.supabase = createMockSupabase().supabase
    state.role = 'invoicer'
  })

  it('refuses a route outside the allowlist before the handler runs', async () => {
    const { route, handler } = routeSeeingClient()
    for (const [method, path] of [
      ['GET', `/api/salary/runs/${ID}/underlag/pdf`],
      ['GET', '/api/transactions'],
      ['GET', '/api/events'],
      ['POST', `/api/invoices/${ID}/mark-paid`],
      ['GET', '/api/bookkeeping/accounts'],
    ]) {
      const res = await route(new Request(`http://localhost${path}`, { method }), PARAMS)
      expect(res.status, path).toBe(403)
      const { body } = await parseJsonResponse(res)
      expect(JSON.stringify(body), path).toContain('INVOICER_ROUTE_NOT_ALLOWED')
    }
    expect(handler).not.toHaveBeenCalled()
  })

  it('gives a scoped route the company-scoped client', async () => {
    const { route, seen } = routeSeeingClient()
    const res = await route(new Request(`http://localhost/api/invoices/${ID}/send`, { method: 'POST' }), PARAMS)
    expect(res.status).toBe(200)
    expect(createCompanyScopedClient).toHaveBeenCalledWith(
      { companyId: 'company-1', userId: 'user-1' },
      expect.anything(),
    )
    expect(seen.supabase).toBe(state.scoped)
  })

  it('keeps the user session on a session route', async () => {
    const { route, seen } = routeSeeingClient()
    const res = await route(new Request('http://localhost/api/invoices', { method: 'GET' }), PARAMS)
    expect(res.status).toBe(200)
    expect(createCompanyScopedClient).not.toHaveBeenCalled()
    expect(seen.supabase).toBe(state.supabase)
  })

  it('changes nothing for other roles, or a role the resolution did not report', async () => {
    for (const role of ['owner', 'member', 'viewer', undefined] as const) {
      state.role = role
      const { route, seen } = routeSeeingClient()
      const res = await route(new Request(`http://localhost/api/salary/runs/${ID}/underlag/pdf`), PARAMS)
      expect(res.status, String(role)).toBe(200)
      expect(seen.supabase, String(role)).toBe(state.supabase)
    }
    expect(createCompanyScopedClient).not.toHaveBeenCalled()
  })
})
