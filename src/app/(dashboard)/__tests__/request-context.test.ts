import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// One server render = one request: the dashboard layout and the page under it
// both ask for the active company's fiscal periods (focused reports,
// /reconciliation) and for the user's profile (Hem). Each used to run its own
// query; the request-cached loaders in request-context.ts run it once.
//
// React's cache() only memoizes inside a server render, which Vitest does not
// have, so it is replaced by the same contract: memoize per arguments for the
// lifetime of the module, and each test imports a fresh module (a new request).

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  cache: <A extends unknown[], R>(fn: (...args: A) => R) => {
    const memo = new Map<string, R>()
    return (...args: A): R => {
      const key = JSON.stringify(args)
      if (!memo.has(key)) memo.set(key, fn(...args))
      return memo.get(key) as R
    }
  },
}))

const tables = vi.hoisted(() => ({ calls: [] as string[] }))

// What the verified access token says (null: getClaims finds no claims and the
// context falls back to getUser), and the headers of the request the proxy
// forwarded to this render.
const request = vi.hoisted(() => ({
  claims: null as null | Record<string, unknown>,
  headers: {} as Record<string, string>,
  resolveCompany: vi.fn(async () => 'company-1'),
}))

function countingClient() {
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'order']) chain[method] = () => chain
  chain.maybeSingle = async () => ({ data: { full_name: 'Test Person' }, error: null })
  chain.then = (resolve: (value: unknown) => void) => resolve({ data: [{ id: 'fp-1' }], error: null })
  return {
    auth: {
      getClaims: async () => ({ data: request.claims ? { claims: request.claims } : null }),
      getUser: async () => ({ data: { user: { id: 'user-1' } } }),
    },
    from: (table: string) => {
      tables.calls.push(table)
      return chain
    },
  }
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => countingClient() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: () => request.resolveCompany() }))
vi.mock('next/headers', () => ({ headers: async () => new Headers(request.headers) }))
vi.mock('@/lib/sandbox/ensure-agent', () => ({ ensureSandboxAgentProfile: vi.fn() }))

async function freshRequest() {
  vi.resetModules()
  return import('../request-context')
}

describe('request-cached dashboard reads', () => {
  beforeEach(() => {
    tables.calls = []
    request.claims = null
    request.headers = {}
    request.resolveCompany.mockClear()
  })

  it('layout + focused report page read fiscal_periods once', async () => {
    const { getDashboardFiscalPeriods } = await freshRequest()

    const [layoutRead, pageRead] = await Promise.all([getDashboardFiscalPeriods(), getDashboardFiscalPeriods()])

    expect(layoutRead.data).toEqual([{ id: 'fp-1' }])
    expect(pageRead).toBe(layoutRead)
    expect(tables.calls.filter((t) => t === 'fiscal_periods')).toHaveLength(1)
  })

  it('layout + Hem read the profile once', async () => {
    const { getDashboardUserProfile } = await freshRequest()

    const [layoutRead, hemRead] = await Promise.all([getDashboardUserProfile(), getDashboardUserProfile()])

    expect(layoutRead.data).toEqual({ full_name: 'Test Person' })
    expect(hemRead).toBe(layoutRead)
    expect(tables.calls.filter((t) => t === 'profiles')).toHaveLength(1)
  })

  it('the next request reads again (nothing is cached across requests)', async () => {
    await (await freshRequest()).getDashboardFiscalPeriods()
    await (await freshRequest()).getDashboardFiscalPeriods()

    expect(tables.calls.filter((t) => t === 'fiscal_periods')).toHaveLength(2)
  })
})

// The proxy resolves the active company for every signed-in page request and
// forwards a signed verdict (lib/auth/active-company-verdict.ts); the render
// must land on exactly that company without a second resolve_active_company.
describe('the active company of a page render', () => {
  const COMPANY = '0b7c6f6e-2f4a-4c1e-9d55-3a1f0c2b9e10'
  const SESSION = { userId: 'user-1', sessionId: 'session-1' }
  const env = { secret: process.env.SESSION_TIMEOUT_SECRET }

  beforeEach(() => {
    tables.calls = []
    process.env.SESSION_TIMEOUT_SECRET = 'request-context-test-secret'
    request.claims = {
      sub: SESSION.userId,
      session_id: SESSION.sessionId,
      aud: 'authenticated',
      // Satisfy the iss pinning (lib/auth/claims.ts) when the test env sets a URL.
      iss: `${(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/+$/, '')}/auth/v1`,
    }
    request.headers = {}
    request.resolveCompany.mockClear()
  })

  afterEach(() => {
    if (env.secret === undefined) delete process.env.SESSION_TIMEOUT_SECRET
    else process.env.SESSION_TIMEOUT_SECRET = env.secret
  })

  async function forwardVerdict(args: { userId?: string; sessionId?: string; companyId?: string; now?: number } = {}) {
    const { ACTIVE_COMPANY_HEADER, signActiveCompany } = await import('@/lib/auth/active-company-verdict')
    const verdict = await signActiveCompany({ ...SESSION, companyId: COMPANY, ...args })
    request.headers = { [ACTIVE_COMPANY_HEADER]: verdict! }
  }

  it('takes the company the proxy resolved for this request, with no resolution of its own', async () => {
    await forwardVerdict()
    const { getDashboardCompanyId } = await freshRequest()

    const [layout, metadata, page] = await Promise.all([
      getDashboardCompanyId(),
      getDashboardCompanyId(),
      getDashboardCompanyId(),
    ])

    expect([layout, metadata, page]).toEqual([COMPANY, COMPANY, COMPANY])
    expect(request.resolveCompany).not.toHaveBeenCalled()
  })

  it('resolves once itself when the proxy vouched for nothing (a Server Action, an API-shaped request)', async () => {
    const { getDashboardCompanyId } = await freshRequest()

    await expect(getDashboardCompanyId()).resolves.toBe('company-1')
    await expect(getDashboardCompanyId()).resolves.toBe('company-1')
    expect(request.resolveCompany).toHaveBeenCalledTimes(1)
  })

  it('resolves itself instead of trusting a verdict for another user, session, or one that expired', async () => {
    for (const args of [{ userId: 'user-2' }, { sessionId: 'session-2' }, { now: Date.now() - 60_000 }]) {
      request.resolveCompany.mockClear()
      await forwardVerdict(args)
      const { getDashboardCompanyId } = await freshRequest()

      await expect(getDashboardCompanyId(), JSON.stringify(args)).resolves.toBe('company-1')
      expect(request.resolveCompany, JSON.stringify(args)).toHaveBeenCalledTimes(1)
    }
  })

  it('resolves itself on the getUser() fallback, where no verified session id exists', async () => {
    await forwardVerdict()
    request.claims = null
    const { getDashboardCompanyId } = await freshRequest()

    await expect(getDashboardCompanyId()).resolves.toBe('company-1')
    expect(request.resolveCompany).toHaveBeenCalledTimes(1)
  })
})
