import { describe, it, expect, vi, beforeEach } from 'vitest'

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

function countingClient() {
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'order']) chain[method] = () => chain
  chain.maybeSingle = async () => ({ data: { full_name: 'Test Person' }, error: null })
  chain.then = (resolve: (value: unknown) => void) => resolve({ data: [{ id: 'fp-1' }], error: null })
  return {
    auth: {
      getClaims: async () => ({ data: null }),
      getUser: async () => ({ data: { user: { id: 'user-1' } } }),
    },
    from: (table: string) => {
      tables.calls.push(table)
      return chain
    },
  }
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => countingClient() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: async () => 'company-1' }))
vi.mock('@/lib/sandbox/ensure-agent', () => ({ ensureSandboxAgentProfile: vi.fn() }))

async function freshRequest() {
  vi.resetModules()
  return import('../request-context')
}

describe('request-cached dashboard reads', () => {
  beforeEach(() => {
    tables.calls = []
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
