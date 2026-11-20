/**
 * The permission shadow at the session door: withRouteContext tells it what
 * its gates did, the response is byte-identical with the shadow on and off,
 * and a disagreement schedules exactly one log write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockSupabase } from '@/tests/helpers'
import type { ActiveCompanyFacts } from '@/lib/company/active-company'
import type { CompanyRole } from '@/types'

const state = vi.hoisted(() => ({
  supabase: null as unknown,
  role: 'member' as CompanyRole | undefined,
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

vi.mock('@/lib/auth/company-scoped-client', () => ({
  createCompanyScopedClient: vi.fn(() => state.supabase),
}))

import { withRouteContext } from '../with-route-context'
import { insertShadowRow } from '@/lib/permissions/shadow-writer'
import { resetPermissionShadowForTests } from '@/lib/permissions/shadow'

const PARAMS = { params: Promise.resolve({}) }
const ID = '7f3c2a10-1b2c-4d5e-8f90-123456789abc'
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Status, headers and body, with the per-request ids (request and trace) normalised. */
async function snapshot(res: Response) {
  // The per-request id and the Server-Timing durations differ per call.
  const strip = (v: string) => v.replace(/req_[0-9a-f-]{36}/g, 'req_X').replace(/dur=\d+/g, 'dur=N')
  const headers = [...res.headers.entries()].filter(([k]) => k !== 'x-request-id' && k !== 'x-trace-id').map(([k, v]) => [k, strip(v)])
  return { status: res.status, headers, body: strip(await res.text()) }
}

async function callTwice(
  makeRoute: () => (req: Request, params: typeof PARAMS) => Promise<Response>,
  method: string,
  path: string,
) {
  process.env.PERMISSIONS_SHADOW = 'off'
  const off = await snapshot(await makeRoute()(new Request(`http://localhost${path}`, { method }), PARAMS))
  await flush()
  expect(insertShadowRow).not.toHaveBeenCalled()
  delete process.env.PERMISSIONS_SHADOW
  const on = await snapshot(await makeRoute()(new Request(`http://localhost${path}`, { method }), PARAMS))
  await flush()
  return { off, on }
}

describe('withRouteContext: permission shadow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetPermissionShadowForTests()
    state.supabase = createMockSupabase().supabase
    state.role = 'member'
    delete process.env.PERMISSIONS_SHADOW
  })
  afterEach(() => {
    delete process.env.PERMISSIONS_SHADOW
  })

  it('answers the same and logs one row when a member passes a gate decide() would refuse', async () => {
    const make = () => withRouteContext('settings.update', async () => NextResponse.json({ data: { ok: true } }), { requireWrite: true })
    const { off, on } = await callTwice(make, 'PUT', '/api/settings')
    expect(on).toEqual(off)
    expect(on.status).toBe(200)
    expect(insertShadowRow).toHaveBeenCalledTimes(1)
    expect(insertShadowRow).toHaveBeenCalledWith(
      expect.objectContaining({
        door: 'session:settings.update',
        method: 'PUT',
        principal_kind: 'person',
        company_id: 'company-1',
        user_id: 'user-1',
        today_outcome: 'allow',
        decide_outcome: 'deny',
        permission: 'settings',
        expected: false,
      }),
    )
  })

  it("logs nothing when the gate's refusal is decide()'s too, and answers the same", async () => {
    state.role = 'viewer'
    const make = () => withRouteContext('invoice.create', async () => NextResponse.json({ data: {} }), { requireWrite: true })
    const { off, on } = await callTwice(make, 'POST', '/api/invoices')
    expect(on).toEqual(off)
    expect(on.status).toBe(403)
    expect(insertShadowRow).not.toHaveBeenCalled()
  })

  it("marks the invoicer allowlist's refusal of an invoicing route as expected", async () => {
    state.role = 'invoicer'
    const make = () => withRouteContext('invoice.mark_paid', async () => NextResponse.json({ data: {} }), { requireWrite: true })
    const { off, on } = await callTwice(make, 'POST', `/api/invoices/${ID}/mark-paid`)
    expect(on).toEqual(off)
    expect(on.status).toBe(403)
    expect(insertShadowRow).toHaveBeenCalledTimes(1)
    expect(insertShadowRow).toHaveBeenCalledWith(
      expect.objectContaining({
        today_outcome: 'deny',
        today_code: 'INVOICER_ROUTE_NOT_ALLOWED',
        decide_outcome: 'allow',
        expected: true,
        expected_reason: 'INVOICER_OUTSIDE_ALLOWLIST',
      }),
    )
  })

  it("reads a handler's 403 as its own check: expected where decide() allows", async () => {
    const make = () =>
      withRouteContext(
        'api_keys.revoke',
        async () => NextResponse.json({ error: { code: 'FORBIDDEN', message: 'colleague key' } }, { status: 403 }),
        { requireWrite: true },
      )
    const { off, on } = await callTwice(make, 'DELETE', `/api/settings/api-keys/${ID}`)
    expect(on).toEqual(off)
    expect(insertShadowRow).toHaveBeenCalledTimes(1)
    expect(insertShadowRow).toHaveBeenCalledWith(
      expect.objectContaining({ today_code: 'HANDLER_FORBIDDEN', expected: true, expected_reason: 'HANDLER_CHECK' }),
    )
  })

  it('never looks at a read', async () => {
    state.role = 'viewer'
    const make = () => withRouteContext('settings.get', async () => NextResponse.json({ data: {} }))
    const { off, on } = await callTwice(make, 'GET', '/api/settings')
    expect(on).toEqual(off)
    expect(insertShadowRow).not.toHaveBeenCalled()
  })
})
