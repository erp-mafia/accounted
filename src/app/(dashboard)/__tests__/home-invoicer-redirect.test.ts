/**
 * Hem ("/") for the invoicing-only role (lib/auth/invoicer-role.ts). The
 * database does not count an invoicer as a member of the company, so Hem's
 * reads (the worklist RPCs, the capability grants) are refused and logged for
 * it. The dashboard layout redirects the role to the invoices, but Next
 * renders the page beside the layout, so the page sends the role away itself
 * before its first read. The request-context loaders run for real here; only
 * the Supabase client underneath them is fake, and it records every read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// React's cache() memoizes only inside a server render: the same per-module
// memo stands in for one request (as in request-context.test.ts).
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

const db = vi.hoisted(() => ({
  tables: [] as string[],
  rpcs: [] as string[],
  memberships: [] as { company_id: string; role: string }[],
}))

const loaders = vi.hoisted(() => ({
  createServiceClient: vi.fn(async () => ({})),
  readAiConnection: vi.fn(async () => ({ connected: false, client: null })),
  readFirstTaskClient: vi.fn(async () => null),
  hasSkatteverketOmbudReadAccess: vi.fn(async () => false),
}))

function fakeUserClient() {
  return {
    auth: {
      getClaims: async () => ({ data: null }),
      getUser: async () => ({ data: { user: { id: 'user-1' } } }),
    },
    rpc: (name: string) => {
      db.rpcs.push(name)
      return Promise.resolve({ data: null, error: null })
    },
    from: (table: string) => {
      db.tables.push(table)
      const result =
        table === 'company_members'
          ? { data: db.memberships, error: null }
          : table === 'team_members'
            ? { data: [], error: null }
            : { data: null, error: null, count: 0 }
      const chain: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'order', 'limit', 'in', 'is', 'not']) chain[method] = () => chain
      chain.maybeSingle = async () => ({ data: null, error: null })
      chain.then = (resolve: (value: unknown) => void) => resolve(result)
      return chain
    },
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => fakeUserClient(),
  createServiceClient: loaders.createServiceClient,
}))
vi.mock('@/lib/company/context', () => ({
  COMPANY_PICKED_COOKIE: 'company-picked',
  getActiveCompanyId: async () => 'company-1',
}))
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-pathname': '/' }),
  cookies: async () => ({ has: () => false }),
}))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`)
  },
}))
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }))
vi.mock('@/lib/sandbox/ensure-agent', () => ({ ensureSandboxAgentProfile: vi.fn() }))
vi.mock('@/lib/onboarding/ai-clients.server', () => ({
  readAiConnection: loaders.readAiConnection,
  readFirstTaskClient: loaders.readFirstTaskClient,
}))
vi.mock('@/lib/skatteverket/ombud-access', () => ({
  hasSkatteverketOmbudReadAccess: loaders.hasSkatteverketOmbudReadAccess,
}))
vi.mock('@/lib/company/home-domain', () => ({ isCockpitLandingRole: () => false }))
vi.mock('../hem-sections', () => ({
  HemChecklistSection: () => null,
  HemNoticesSection: () => null,
  HemPanesSection: () => null,
}))
vi.mock('@/components/dashboard/DashboardContent', () => ({ default: () => null }))
vi.mock('@/components/dashboard/HemDone', () => ({ HemDone: () => null }))
vi.mock('@/components/dashboard/HemSkeletons', () => ({ ChecklistSkeleton: () => null, PanesSkeleton: () => null }))
vi.mock('@/components/system/RefreshWhenRestored', () => ({ RefreshWhenRestored: () => null }))
vi.mock('@/components/ui/page-header', () => ({ PageHeader: () => null }))
vi.mock('@/components/ui/help-popover', () => ({ HelpPopover: () => null }))

async function renderHem() {
  vi.resetModules()
  const { default: DashboardPage } = await import('../page')
  return DashboardPage()
}

// Each test loads the page's whole module graph afresh (resetModules), which
// alone takes seconds on a busy runner: the limit covers the load, not the redirect.
vi.setConfig({ testTimeout: 20_000 })

beforeEach(() => {
  vi.clearAllMocks()
  db.tables = []
  db.rpcs = []
})

describe('Hem for an invoicer', () => {
  it('redirects to the invoices before any Hem read', async () => {
    db.memberships = [{ company_id: 'company-1', role: 'invoicer' }]

    await expect(renderHem()).rejects.toThrow('redirect:/invoices')

    // Only the memberships (shared with the layout) and the byrå landing
    // check, which runs beside the guard; no company read, no RPC.
    expect(new Set(db.tables)).toEqual(new Set(['company_members', 'team_members']))
    expect(db.rpcs).toEqual([])
    expect(loaders.createServiceClient).not.toHaveBeenCalled()
    expect(loaders.readAiConnection).not.toHaveBeenCalled()
    expect(loaders.readFirstTaskClient).not.toHaveBeenCalled()
    expect(loaders.hasSkatteverketOmbudReadAccess).not.toHaveBeenCalled()
  })

  it('runs the Hem reads as before for every other role', async () => {
    db.memberships = [{ company_id: 'company-1', role: 'owner' }]

    // The fake company has no settings row, so Hem ends at the onboarding
    // gate, after its reads.
    await expect(renderHem()).rejects.toThrow('redirect:/onboarding')

    expect(db.tables).toContain('company_settings')
    expect(db.tables).toContain('skatteverket_tokens')
    expect(loaders.readAiConnection).toHaveBeenCalledWith(expect.anything(), 'user-1')
    expect(loaders.hasSkatteverketOmbudReadAccess).toHaveBeenCalledWith('company-1')
  })
})
