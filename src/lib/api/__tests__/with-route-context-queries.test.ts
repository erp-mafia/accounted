import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

// Database round trips one request costs before its handler runs, with the
// REAL company resolution (lib/company/active-company.ts) and the REAL write
// guard (lib/auth/require-write.ts). Only requireAuth is mocked, to hand over
// a client that counts every PostgREST call (rpc + from).
//
// A write route used to pay two: resolve_active_company, then a
// company_members select for the role. The resolver now returns the role, so
// it pays one; the 403 for a viewer is unchanged. The "database without the
// role column" cases are the old cost, which is also what a deploy that
// lands before its migration pays: never a failure, just no saving.

const db = vi.hoisted(() => ({
  rpcRow: null as Record<string, unknown> | null,
  memberRole: null as string | null,
  calls: [] as string[],
}))

function countingSupabase() {
  const chain = (table: string) => {
    const self: Record<string, unknown> = {
      select: () => self,
      eq: () => self,
      maybeSingle: async () => ({
        data: table === 'company_members' && db.memberRole ? { role: db.memberRole } : null,
        error: null,
      }),
    }
    return self
  }
  return {
    rpc: vi.fn(async (name: string) => {
      db.calls.push(`rpc:${name}`)
      return { data: db.rpcRow ? [db.rpcRow] : [], error: null }
    }),
    from: vi.fn((table: string) => {
      db.calls.push(`from:${table}`)
      return chain(table)
    }),
  }
}

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(async () => ({ user: { id: 'user-1' }, supabase: countingSupabase() })),
}))

import { withRouteContext } from '../with-route-context'

const EMPTY_PARAMS = { params: Promise.resolve({}) }
const post = () => new Request('http://localhost/api/test', { method: 'POST' })

/** The resolver row as the migrated database returns it. */
const resolved = (role: string) => ({ company_id: 'company-1', locale: 'sv', used_fallback: false, role })
/** The same row from a database without 20261012101000 (no role column). */
const resolvedWithoutRole = () => ({ company_id: 'company-1', locale: 'sv', used_fallback: false })

describe('withRouteContext database round trips before the handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.calls = []
    db.rpcRow = null
    db.memberRole = null
    vi.unstubAllEnvs()
  })

  it('a write route by a member costs one query (the resolver) and reaches the handler', async () => {
    db.rpcRow = resolved('member')
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))

    const res = await withRouteContext('test.write', handler, { requireWrite: true })(post(), EMPTY_PARAMS)

    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(db.calls).toEqual(['rpc:resolve_active_company'])
  })

  it.each(['owner', 'admin'])('a write route by an %s costs one query', async (role) => {
    db.rpcRow = resolved(role)

    const res = await withRouteContext('test.write', async () => NextResponse.json({ ok: true }), {
      requireWrite: true,
    })(post(), EMPTY_PARAMS)

    expect(res.status).toBe(200)
    expect(db.calls).toEqual(['rpc:resolve_active_company'])
  })

  it('a write route by a viewer is refused with the same 403, in one query', async () => {
    db.rpcRow = resolved('viewer')
    const handler = vi.fn(async () => NextResponse.json({ ok: true }))

    const res = await withRouteContext('test.write', handler, { requireWrite: true })(post(), EMPTY_PARAMS)

    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Du har endast läsbehörighet i detta företag.',
      details: { code: 'ROLE_READ_ONLY' },
    })
    expect(res.headers.get('X-Request-Id')).toMatch(/^req_/)
    expect(handler).not.toHaveBeenCalled()
    expect(db.calls).toEqual(['rpc:resolve_active_company'])
  })

  it('the seat-gated resolver reports the role the same way', async () => {
    vi.stubEnv('MULTI_USER_SEAT_GATE', 'true')
    db.rpcRow = { ...resolved('viewer'), has_locked_membership: false }

    const res = await withRouteContext('test.write', async () => NextResponse.json({ ok: true }), {
      requireWrite: true,
    })(post(), EMPTY_PARAMS)

    expect(res.status).toBe(403)
    expect(db.calls).toEqual(['rpc:resolve_active_company_gated'])
  })

  describe('database without the role column (the old cost; also a deploy ahead of its migration)', () => {
    it('a member still writes, after a company_members read', async () => {
      db.rpcRow = resolvedWithoutRole()
      db.memberRole = 'member'

      const res = await withRouteContext('test.write', async () => NextResponse.json({ ok: true }), {
        requireWrite: true,
      })(post(), EMPTY_PARAMS)

      expect(res.status).toBe(200)
      expect(db.calls).toEqual(['rpc:resolve_active_company', 'from:company_members'])
    })

    it('a viewer is still refused with 403, after a company_members read', async () => {
      db.rpcRow = resolvedWithoutRole()
      db.memberRole = 'viewer'

      const res = await withRouteContext('test.write', async () => NextResponse.json({ ok: true }), {
        requireWrite: true,
      })(post(), EMPTY_PARAMS)

      expect(res.status).toBe(403)
      expect(db.calls).toEqual(['rpc:resolve_active_company', 'from:company_members'])
    })
  })

  it('a read route costs one query, as before', async () => {
    db.rpcRow = resolved('viewer')

    const res = await withRouteContext('test.read', async () => NextResponse.json({ ok: true }))(
      new Request('http://localhost/api/test'),
      EMPTY_PARAMS,
    )

    expect(res.status).toBe(200)
    expect(db.calls).toEqual(['rpc:resolve_active_company'])
  })
})
