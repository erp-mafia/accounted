import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { parseJsonResponse } from '@/tests/helpers'

/**
 * What withRouteContext answers when the active company cannot be resolved.
 * The real resolver (lib/company/active-company.ts) reads a client whose
 * resolver RPC answers as production's did; only the sign-in is stubbed.
 */

const signedIn = vi.hoisted(() => ({ value: true }))
const rpc = vi.hoisted(() => vi.fn())
// The query path: called only if a resolution fell back to reading memberships.
const from = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(async () => {
    const supabase = { rpc, from }
    if (!signedIn.value) {
      return {
        user: null,
        supabase,
        error: NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Logga in igen.' } }, { status: 401 }),
      }
    }
    return { user: { id: 'user-1' }, supabase, error: null }
  }),
}))

import { withRouteContext } from '../with-route-context'
import { RESOLVER_FAILURES } from '@/tests/fixtures/company-resolver-failures'

type Envelope = { error: { code: string; message: string; requestId?: string } }

const handled = vi.fn()
const route = withRouteContext('test.company', async (_request, ctx) => {
  handled(ctx.companyId, ctx.role)
  return NextResponse.json({ ok: true })
})

function call() {
  return route(new Request('http://localhost/api/test'), { params: Promise.resolve({}) })
}

describe('withRouteContext: resolving the active company', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    signedIn.value = true
    rpc.mockResolvedValue({
      data: [{ company_id: 'company-1', locale: 'sv', used_fallback: false, role: 'owner' }],
      error: null,
    })
  })

  it('answers 401 and resolves nothing for a caller who is not signed in', async () => {
    signedIn.value = false

    const res = await call()

    expect(res.status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
    expect(handled).not.toHaveBeenCalled()
  })

  it('runs the handler in the company the resolver answered', async () => {
    const res = await call()

    expect(res.status).toBe(200)
    expect(handled).toHaveBeenCalledWith('company-1', 'owner')
  })

  it('answers COMPANY_CONTEXT_MISSING (400) to a user who has no company', async () => {
    rpc.mockResolvedValue({
      data: [{ company_id: null, locale: null, used_fallback: true, role: null }],
      error: null,
    })

    const res = await call()
    const { status, body } = await parseJsonResponse<Envelope>(res)

    expect(status).toBe(400)
    expect(body.error.code).toBe('COMPANY_CONTEXT_MISSING')
    expect(handled).not.toHaveBeenCalled()
  })

  it.each(RESOLVER_FAILURES)(
    'answers TRANSIENT_ERROR (503), not "Välj ett företag", when the resolution fails: %s',
    async (_label, error) => {
      rpc.mockResolvedValue({ data: null, error })

      const res = await call()
      const { status, body } = await parseJsonResponse<Envelope>(res)

      expect(status).toBe(503)
      expect(body.error.code).toBe('TRANSIENT_ERROR')
      expect(body.error.requestId).toMatch(/^req_/)
      expect(body.error.requestId).toBe(res.headers.get('X-Request-Id'))
      // No other company is tried in its place: the resolver is asked once,
      // the membership query path is never read, and the handler never runs.
      expect(rpc).toHaveBeenCalledTimes(1)
      expect(from).not.toHaveBeenCalled()
      expect(handled).not.toHaveBeenCalled()
    },
  )
})
