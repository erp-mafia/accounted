import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

/**
 * What the extension dispatcher answers when the active company cannot be
 * resolved: the same as a core route (withRouteContext). The real resolver
 * (lib/company/active-company.ts) reads a client whose resolver RPC answers
 * as production's did; the sign-in, lib/init and the extension context are
 * stubbed.
 */

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

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

// The handler's context names the company it runs in.
vi.mock('@/lib/extensions/context-factory', () => ({
  createExtensionContext: vi.fn((_supabase: unknown, userId: string, companyId: string) => ({ userId, companyId })),
}))

import { extensionRegistry } from '@/lib/extensions/registry'
import { GET } from '../route'
import { RESOLVER_FAILURES } from '@/tests/fixtures/company-resolver-failures'

type Envelope = { error: { code: string; message: string; requestId?: string } }

const handler = vi.fn(async (_request: Request, ctx?: unknown) =>
  NextResponse.json({ companyId: (ctx as { companyId?: string } | undefined)?.companyId ?? null }),
)

function call() {
  return GET(createMockRequest('/api/extensions/ext/probe-ext/status'), {
    params: Promise.resolve({ path: ['probe-ext', 'status'] }),
  })
}

describe('extension dispatcher: resolving the active company', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    signedIn.value = true
    extensionRegistry.clear()
    extensionRegistry.register({
      id: 'probe-ext',
      name: 'Probe',
      version: '1.0.0',
      apiRoutes: [{ method: 'GET', path: '/status', handler }],
    })
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
    expect(handler).not.toHaveBeenCalled()
  })

  it('runs the handler in the company the resolver answered', async () => {
    const res = await call()
    const { status, body } = await parseJsonResponse<{ companyId: string }>(res)

    expect(status).toBe(200)
    expect(body.companyId).toBe('company-1')
  })

  it('answers COMPANY_CONTEXT_MISSING (400), as a core route does, to a user who has no company', async () => {
    rpc.mockResolvedValue({
      data: [{ company_id: null, locale: null, used_fallback: true, role: null }],
      error: null,
    })

    const res = await call()
    const { status, body } = await parseJsonResponse<Envelope>(res)

    expect(status).toBe(400)
    expect(body.error.code).toBe('COMPANY_CONTEXT_MISSING')
    expect(body.error.requestId).toBe(res.headers.get('X-Request-Id'))
    expect(handler).not.toHaveBeenCalled()
  })

  it.each(RESOLVER_FAILURES)(
    'answers TRANSIENT_ERROR (503), as a core route does, when the resolution fails: %s',
    async (_label, error) => {
      rpc.mockResolvedValue({ data: null, error })

      const res = await call()
      const { status, body } = await parseJsonResponse<Envelope>(res)

      expect(status).toBe(503)
      expect(body.error.code).toBe('TRANSIENT_ERROR')
      expect(body.error.requestId).toBe(res.headers.get('X-Request-Id'))
      // No other company is tried in its place: the resolver is asked once,
      // the membership query path is never read, and the handler never runs.
      expect(rpc).toHaveBeenCalledTimes(1)
      expect(from).not.toHaveBeenCalled()
      expect(handler).not.toHaveBeenCalled()
    },
  )
})
