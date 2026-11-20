/**
 * PATCH /api/customers/[id]/collections-exclusion through the real
 * withRouteContext over an in-memory database: 401 without a session, 403
 * for a viewer, 400 on a bad id or body, 503 while collections is dark (the
 * flag is offered only while collections is), 404 for a customer of another
 * company, and the flag set and lifted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createCaseWorld, CUSTOMER_ID, type CaseWorld } from '@/lib/collections/__tests__/case-fixtures'
import { ADMIN_ID, COMPANY_ID } from '@/lib/collections/__tests__/memory-supabase'

let world: CaseWorld

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111') }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => world.db.client, createClient: async () => world.db.client }))
const requireWritePermissionMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: (...args: unknown[]) => requireWritePermissionMock(...args) }))
const hasCapabilityMock = vi.fn()
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/has-capability')>()),
  hasCapability: (...args: unknown[]) => hasCapabilityMock(...args),
}))
vi.mock('@/lib/sandbox/guard', () => ({ isSandboxCompany: vi.fn().mockResolvedValue(false) }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { PATCH } from '../route'

const OTHER_CUSTOMER = '99999999-9999-4999-8999-999999999999'

const call = (body: unknown, id: string = CUSTOMER_ID) =>
  PATCH(
    new Request(`http://localhost/api/customers/${id}/collections-exclusion`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )

function switchOn() {
  vi.stubEnv('COLLECTIONS_ENABLED', '1')
  vi.stubEnv('COLLECTIONS_PILOT_COMPANIES', COMPANY_ID)
}

const flag = (id: string = CUSTOMER_ID) => world.db.rows('customers').find((r) => r.id === id)?.collections_excluded

beforeEach(async () => {
  vi.clearAllMocks()
  for (const k of ['COLLECTIONS_ENABLED', 'COLLECTIONS_PILOT_COMPANIES']) vi.stubEnv(k, '')
  world = await createCaseWorld({ customer: { collections_excluded: false } })
  world.db.seed('customers', [{ id: OTHER_CUSTOMER, company_id: 'other-company', name: 'Annan AB', collections_excluded: false }])
  requireAuthMock.mockResolvedValue({
    user: { id: ADMIN_ID, email: 'ada@test.se', user_metadata: { full_name: 'Ada Admin' }, is_anonymous: false },
    supabase: world.db.client,
    error: null,
  })
  requireWritePermissionMock.mockResolvedValue({ ok: true })
  hasCapabilityMock.mockResolvedValue(true)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('PATCH /api/customers/[id]/collections-exclusion', () => {
  it('answers 401 without a session', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: null,
      error: new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 }),
    })
    expect((await call({ excluded: true })).status).toBe(401)
  })

  it('answers 403 for a viewer and writes nothing', async () => {
    switchOn()
    requireWritePermissionMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    expect((await call({ excluded: true })).status).toBe(403)
    expect(flag()).toBe(false)
  })

  it('answers 400 for a bad id or body', async () => {
    switchOn()
    expect((await call({ excluded: true }, 'not-a-uuid')).status).toBe(400)
    expect((await call({ excluded: 'yes' })).status).toBe(400)
    expect((await call({})).status).toBe(400)
    expect(flag()).toBe(false)
  })

  it('answers 503 while collections is dark, and 403 without the paid capability', async () => {
    expect((await call({ excluded: true })).status).toBe(503)
    switchOn()
    hasCapabilityMock.mockResolvedValue(false)
    expect((await call({ excluded: true })).status).toBe(403)
    expect(flag()).toBe(false)
  })

  it('answers 404 for a customer of another company and leaves it alone', async () => {
    switchOn()
    const res = await call({ excluded: true }, OTHER_CUSTOMER)
    expect(res.status).toBe(404)
    expect(flag(OTHER_CUSTOMER)).toBe(false)
  })

  it('marks the customer "Skicka aldrig till inkasso" and lifts it again, before activation too', async () => {
    switchOn()
    world.db.rows('collection_connections').splice(0)
    const on = await call({ excluded: true })
    expect(on.status).toBe(200)
    expect(await on.json()).toEqual({ data: { id: CUSTOMER_ID, collections_excluded: true } })
    expect(flag()).toBe(true)

    const off = await call({ excluded: false })
    expect(off.status).toBe(200)
    expect(await off.json()).toEqual({ data: { id: CUSTOMER_ID, collections_excluded: false } })
    expect(flag()).toBe(false)
  })
})
