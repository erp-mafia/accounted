import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCookieSet } = vi.hoisted(() => ({ mockCookieSet: vi.fn() }))

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ set: mockCookieSet })),
}))

// Multi-user seat gate seam. Default: NOT enforced and every membership
// active, so the pre-existing tests keep documenting the ungated resolution
// (the self-hosted / dev behavior, and the pre-gate semantics). The gated
// tests at the bottom flip these; the gate's own logic is covered in
// lib/entitlements/__tests__/multi-user.test.ts.
const multiUserSeam = vi.hoisted(() => ({
  enforced: false,
  membershipActive: vi.fn().mockResolvedValue(true),
}))
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>(
    '@/lib/entitlements/multi-user',
  )
  return {
    ...actual,
    isMultiUserEnforced: () => multiUserSeam.enforced,
    isMembershipActive: (...args: unknown[]) => multiUserSeam.membershipActive(...args),
  }
})

import { setActiveCompany, CompanyContextError, getCompanyDisplayName, getActiveCompanyId } from '../context'

type CapturedCall = { table: string; method: string; args: unknown[] }

type TerminalResult = { data?: unknown; error?: unknown }

/**
 * Chainable Supabase mock (same approach as actions.test.ts): a chain method
 * terminates with `results[table][method]` when seeded, otherwise keeps
 * chaining. setActiveCompany ends both its queries on `.single()`, on
 * different tables, so seeding `single` per table drives each branch.
 * A terminal seeded as an ARRAY is consumed in call order, for functions
 * that query the same table twice (getActiveCompanyId's fallback fetch +
 * preference validation both end on company_members.maybeSingle()).
 *
 * `rpcResult` seeds supabase.rpc('resolve_active_company'). The default is a
 * PGRST202 "function not found" error so every pre-RPC test keeps passing
 * unchanged: they now exercise the query fallback path, which is exactly the
 * behavior on a not-yet-migrated database.
 */
function buildSupabase(
  results: Record<string, Record<string, TerminalResult | TerminalResult[]>>,
  rpcResult: TerminalResult = {
    data: null,
    error: { code: 'PGRST202', message: 'Could not find the function' },
  },
) {
  const calls: CapturedCall[] = []

  function makeChain(table: string) {
    const chain: Record<string, unknown> = {}
    const methods = ['select', 'eq', 'is', 'or', 'order', 'limit', 'maybeSingle', 'single', 'insert', 'upsert', 'delete', 'update']
    for (const m of methods) {
      chain[m] = (...args: unknown[]) => {
        calls.push({ table, method: m, args })
        const seeded = results[table]?.[m]
        const terminal = Array.isArray(seeded) ? seeded.shift() : seeded
        if (terminal) {
          return Promise.resolve({ data: terminal.data ?? null, error: terminal.error ?? null })
        }
        return chain
      }
    }
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
    return chain
  }

  const supabase = {
    from: vi.fn().mockImplementation((table: string) => makeChain(table)),
    rpc: vi.fn(async () => ({
      data: rpcResult.data ?? null,
      error: rpcResult.error ?? null,
    })),
  }

  return { supabase, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
  multiUserSeam.enforced = false
  multiUserSeam.membershipActive.mockResolvedValue(true)
})

describe('setActiveCompany', () => {
  it('throws not_member and never writes when the user lacks membership', async () => {
    const { supabase, calls } = buildSupabase({
      company_members: { single: { data: null, error: { message: 'no rows' } } },
    })

    const err = await setActiveCompany(supabase as never, 'user-1', 'company-2').catch((e) => e)

    expect(err).toBeInstanceOf(CompanyContextError)
    expect(err.code).toBe('not_member')
    expect(calls.find((c) => c.table === 'user_preferences')).toBeUndefined()
    expect(mockCookieSet).not.toHaveBeenCalled()
  })

  it('throws persist_failed and does NOT set the cookie when the upsert errors (#701)', async () => {
    const { supabase } = buildSupabase({
      company_members: { single: { data: { company_id: 'company-2' } } },
      user_preferences: { single: { data: null, error: { message: 'permission denied' } } },
    })

    const err = await setActiveCompany(supabase as never, 'user-1', 'company-2').catch((e) => e)

    expect(err).toBeInstanceOf(CompanyContextError)
    expect(err.code).toBe('persist_failed')
    expect(err.message).toContain('permission denied')
    // The exact regression from #701: cookie must not diverge from the DB.
    expect(mockCookieSet).not.toHaveBeenCalled()
  })

  it('throws persist_failed when the read-back does not return the new company', async () => {
    // An RLS-filtered UPDATE affects zero rows without an error; the
    // read-back is what catches it. Simulate a stale/foreign row coming back.
    const { supabase } = buildSupabase({
      company_members: { single: { data: { company_id: 'company-2' } } },
      user_preferences: { single: { data: { active_company_id: 'company-1' } } },
    })

    const err = await setActiveCompany(supabase as never, 'user-1', 'company-2').catch((e) => e)

    expect(err).toBeInstanceOf(CompanyContextError)
    expect(err.code).toBe('persist_failed')
    expect(mockCookieSet).not.toHaveBeenCalled()
  })

  it('sets the cookies only after the write is verified', async () => {
    const { supabase, calls } = buildSupabase({
      company_members: { single: { data: { company_id: 'company-2' } } },
      user_preferences: { single: { data: { active_company_id: 'company-2' } } },
    })

    await expect(setActiveCompany(supabase as never, 'user-1', 'company-2')).resolves.toBeUndefined()

    const upsert = calls.find((c) => c.table === 'user_preferences' && c.method === 'upsert')
    expect(upsert?.args[0]).toEqual({ user_id: 'user-1', active_company_id: 'company-2' })
    expect(mockCookieSet).toHaveBeenCalledTimes(2)
    expect(mockCookieSet).toHaveBeenCalledWith(
      'gnubok-company-id',
      'company-2',
      expect.objectContaining({ httpOnly: true, path: '/' }),
    )
    // The explicit-choice marker (byrå landing): must be a SESSION cookie
    // (no maxAge), so a new browser session starts unpicked and byrå
    // owners/admins land in the cockpit again.
    const picked = mockCookieSet.mock.calls.find((c) => c[0] === 'gnubok-company-picked')
    expect(picked?.[1]).toBe('1')
    expect(picked?.[2]).toEqual(
      expect.objectContaining({ httpOnly: true, path: '/', sameSite: 'lax' }),
    )
    expect(picked?.[2]).not.toHaveProperty('maxAge')
  })
})

describe('getActiveCompanyId', () => {
  it('resolves the preferred company with ONE company_members query when it is the first membership', async () => {
    const { supabase, calls } = buildSupabase({
      user_preferences: { maybeSingle: { data: { active_company_id: 'company-1' } } },
      company_members: { maybeSingle: { data: { company_id: 'company-1' } } },
    })

    const id = await getActiveCompanyId(supabase as never, 'user-1')

    expect(id).toBe('company-1')
    // The parallel fallback fetch doubles as validation in the common
    // single-company case: no second, sequential round trip.
    const memberQueries = calls.filter((c) => c.table === 'company_members' && c.method === 'maybeSingle')
    expect(memberQueries).toHaveLength(1)
  })

  it('validates a preference that differs from the first membership', async () => {
    const { supabase, calls } = buildSupabase({
      user_preferences: { maybeSingle: { data: { active_company_id: 'company-2' } } },
      company_members: {
        maybeSingle: [
          { data: { company_id: 'company-1' } }, // first membership (parallel fetch)
          { data: { company_id: 'company-2' } }, // validation of the preference
        ],
      },
    })

    const id = await getActiveCompanyId(supabase as never, 'user-1')

    expect(id).toBe('company-2')
    const memberQueries = calls.filter((c) => c.table === 'company_members' && c.method === 'maybeSingle')
    expect(memberQueries).toHaveLength(2)
  })

  it('falls back to the first membership when the preference is stale', async () => {
    const { supabase } = buildSupabase({
      user_preferences: { maybeSingle: { data: { active_company_id: 'company-archived' } } },
      company_members: {
        maybeSingle: [
          { data: { company_id: 'company-1' } }, // first membership
          { data: null }, // validation: preference archived / membership gone
        ],
      },
    })

    expect(await getActiveCompanyId(supabase as never, 'user-1')).toBe('company-1')
  })

  it('falls back to the first membership when there is no preference row', async () => {
    const { supabase, calls } = buildSupabase({
      user_preferences: { maybeSingle: { data: null } },
      company_members: { maybeSingle: { data: { company_id: 'company-1' } } },
    })

    expect(await getActiveCompanyId(supabase as never, 'user-1')).toBe('company-1')
    const memberQueries = calls.filter((c) => c.table === 'company_members' && c.method === 'maybeSingle')
    expect(memberQueries).toHaveLength(1)
  })

  it('returns null when the user has no non-archived memberships', async () => {
    const { supabase } = buildSupabase({
      user_preferences: { maybeSingle: { data: null } },
      company_members: { maybeSingle: { data: null } },
    })

    expect(await getActiveCompanyId(supabase as never, 'user-1')).toBeNull()
  })

  // A failed query must throw, never read as "no companies": callers redirect
  // the null state to the onboarding wizard, and a transient failure was
  // enough to show onboarding to a fully onboarded user (issue #1053).
  it('throws resolution_failed when the preferences query fails', async () => {
    const { supabase } = buildSupabase({
      user_preferences: { maybeSingle: { data: null, error: { message: 'fetch failed' } } },
      company_members: { maybeSingle: { data: { company_id: 'company-1' } } },
    })

    const err = await getActiveCompanyId(supabase as never, 'user-1').catch((e) => e)

    expect(err).toBeInstanceOf(CompanyContextError)
    expect(err.code).toBe('resolution_failed')
  })

  it('throws resolution_failed when the membership query fails', async () => {
    const { supabase } = buildSupabase({
      user_preferences: { maybeSingle: { data: null } },
      company_members: { maybeSingle: { data: null, error: { message: 'timeout' } } },
    })

    const err = await getActiveCompanyId(supabase as never, 'user-1').catch((e) => e)

    expect(err).toBeInstanceOf(CompanyContextError)
    expect(err.code).toBe('resolution_failed')
  })

  it('throws instead of silently switching company when preference validation fails', async () => {
    const { supabase } = buildSupabase({
      user_preferences: { maybeSingle: { data: { active_company_id: 'company-2' } } },
      company_members: {
        maybeSingle: [
          { data: { company_id: 'company-1' } }, // first membership (parallel fetch)
          { data: null, error: { message: 'connection reset' } }, // validation FAILS
        ],
      },
    })

    const err = await getActiveCompanyId(supabase as never, 'user-1').catch((e) => e)

    // Falling back to company-1 here would silently flip a consultant onto
    // the wrong company's books.
    expect(err).toBeInstanceOf(CompanyContextError)
    expect(err.code).toBe('resolution_failed')
  })
})

describe('getActiveCompanyId via resolve_active_company RPC', () => {
  it('resolves from the RPC in one call without touching any table', async () => {
    const { supabase } = buildSupabase(
      {},
      { data: [{ company_id: 'company-1', locale: 'sv', used_fallback: false }] },
    )

    const id = await getActiveCompanyId(supabase as never, 'user-1')

    expect(id).toBe('company-1')
    expect(supabase.rpc).toHaveBeenCalledWith('resolve_active_company')
    // The whole point of the RPC: zero PostgREST table round trips.
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('returns null from an RPC row with a null company_id (no companies) without table queries', async () => {
    const { supabase } = buildSupabase(
      {},
      { data: [{ company_id: null, locale: 'en', used_fallback: true }] },
    )

    expect(await getActiveCompanyId(supabase as never, 'user-1')).toBeNull()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('throws resolution_failed on a non-fallback RPC error instead of masking it', async () => {
    const { supabase } = buildSupabase(
      {},
      { data: null, error: { code: '57014', message: 'statement timeout' } },
    )

    const err = await getActiveCompanyId(supabase as never, 'user-1').catch((e) => e)

    expect(err).toBeInstanceOf(CompanyContextError)
    expect(err.code).toBe('resolution_failed')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('falls back to the query path on 42501 (service-role client lacks EXECUTE)', async () => {
    // The mcp-oauth token route and the events route (API-key branch) call
    // requireCompanyId with createServiceClientNoCookies(): EXECUTE is
    // granted to `authenticated` only, so the RPC refuses with 42501 and the
    // query path (filtered by the explicit userId param) must take over.
    const { supabase } = buildSupabase(
      {
        user_preferences: { maybeSingle: { data: { active_company_id: 'company-1' } } },
        company_members: { maybeSingle: { data: { company_id: 'company-1' } } },
      },
      { data: null, error: { code: '42501', message: 'permission denied for function' } },
    )

    expect(await getActiveCompanyId(supabase as never, 'user-1')).toBe('company-1')
  })

  it('falls back to the query path on zero RPC rows (NULL auth.uid(), service client)', async () => {
    const { supabase } = buildSupabase(
      {
        user_preferences: { maybeSingle: { data: null } },
        company_members: { maybeSingle: { data: { company_id: 'company-1' } } },
      },
      { data: [] },
    )

    expect(await getActiveCompanyId(supabase as never, 'user-1')).toBe('company-1')
  })
})

describe('multi-user seat gate', () => {
  it('setActiveCompany refuses a switch into a company frozen for the member', async () => {
    multiUserSeam.membershipActive.mockResolvedValue(false)
    const { supabase, calls } = buildSupabase({
      company_members: { single: { data: { company_id: 'company-2', role: 'member' } } },
    })

    const err = await setActiveCompany(supabase as never, 'user-1', 'company-2').catch((e) => e)

    expect(err).toBeInstanceOf(CompanyContextError)
    expect(err.code).toBe('company_locked')
    // The preference write must never land: a persisted frozen preference
    // would silently bounce every later resolution.
    expect(calls.find((c) => c.table === 'user_preferences')).toBeUndefined()
    expect(mockCookieSet).not.toHaveBeenCalled()
  })

  it('getActiveCompanyId calls the GATED rpc when enforcement is on', async () => {
    multiUserSeam.enforced = true
    const { supabase } = buildSupabase(
      {},
      { data: [{ company_id: 'company-1', locale: 'sv', used_fallback: false }] },
    )

    expect(await getActiveCompanyId(supabase as never, 'user-1')).toBe('company-1')
    expect(supabase.rpc).toHaveBeenCalledWith('resolve_active_company_gated', {
      p_grace_days: 20,
    })
  })

  it('gated query fallback resolves the first ACCESSIBLE membership (dormant skipped)', async () => {
    multiUserSeam.enforced = true
    const memberships = [
      // Frozen for the user: non-owner and no grant rows will match below.
      { company_id: 'frozen-co', role: 'member', created_at: '2026-01-01', companies: { team_id: null } },
      { company_id: 'owned-co', role: 'owner', created_at: '2026-02-01', companies: { team_id: null } },
    ]
    const { supabase } = buildSupabase(
      {
        user_preferences: { maybeSingle: { data: { active_company_id: 'frozen-co' } } },
        // The gated path awaits the list query (no maybeSingle): seed the
        // chain's `order` terminal.
        company_members: { order: { data: memberships } },
        // No multi_user grants at all -> frozen-co is frozen for the member
        // (the shared rpc mock returns zero rows for company_multi_user_state
        // too, so getMultiUserState falls through to this grants read).
        capability_grants: { or: { data: [] } },
      },
      // Zero RPC rows = NULL auth.uid() (service-role client): routes to the
      // GATED query path, unlike PGRST202 (migration absent), which fails open.
      { data: [] },
    )

    // Preference points at the frozen company: resolution must skip it and
    // land on the owned company instead of locking the user out.
    expect(await getActiveCompanyId(supabase as never, 'user-1')).toBe('owned-co')
  })

  it('PGRST202 on the gated rpc fails OPEN via the ungated query path (deploy race)', async () => {
    multiUserSeam.enforced = true
    // Default rpcResult is PGRST202. Pre-migration there are no multi_user
    // rows, so the gated path would freeze this non-owner: the fallback must
    // be the UNGATED path and still resolve their membership.
    const { supabase } = buildSupabase({
      user_preferences: { maybeSingle: { data: { active_company_id: 'company-1' } } },
      company_members: { maybeSingle: { data: { company_id: 'company-1' } } },
    })

    expect(await getActiveCompanyId(supabase as never, 'user-1')).toBe('company-1')
  })
})

describe('getCompanyDisplayName', () => {
  it('returns company_settings.company_name and never reads companies when set', async () => {
    const { supabase, calls } = buildSupabase({
      company_settings: { maybeSingle: { data: { company_name: 'Ny Firma AB' } } },
      companies: { maybeSingle: { data: { name: 'Aktiebolaget Grundstenen 000000' } } },
    })

    const name = await getCompanyDisplayName(supabase as never, 'company-1')

    expect(name).toBe('Ny Firma AB')
    // companies.name is the frozen onboarding value: it must not be consulted
    // when the user has set a current name in settings.
    expect(calls.find((c) => c.table === 'companies')).toBeUndefined()
  })

  it('falls back to companies.name when company_settings has no row', async () => {
    const { supabase } = buildSupabase({
      company_settings: { maybeSingle: { data: null } },
      companies: { maybeSingle: { data: { name: 'Aktiebolaget Grundstenen 000000' } } },
    })

    expect(await getCompanyDisplayName(supabase as never, 'company-1')).toBe(
      'Aktiebolaget Grundstenen 000000',
    )
  })

  it('falls back to companies.name when company_settings.company_name is empty', async () => {
    const { supabase } = buildSupabase({
      company_settings: { maybeSingle: { data: { company_name: '' } } },
      companies: { maybeSingle: { data: { name: 'Bolaget AB' } } },
    })

    expect(await getCompanyDisplayName(supabase as never, 'company-1')).toBe('Bolaget AB')
  })

  it('returns null when neither table resolves a name', async () => {
    const { supabase } = buildSupabase({
      company_settings: { maybeSingle: { data: null } },
      companies: { maybeSingle: { data: null } },
    })

    expect(await getCompanyDisplayName(supabase as never, 'company-1')).toBeNull()
  })
})
