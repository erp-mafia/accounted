import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCookieSet } = vi.hoisted(() => ({ mockCookieSet: vi.fn() }))

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ set: mockCookieSet })),
}))

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
 */
function buildSupabase(results: Record<string, Record<string, TerminalResult | TerminalResult[]>>) {
  const calls: CapturedCall[] = []

  function makeChain(table: string) {
    const chain: Record<string, unknown> = {}
    const methods = ['select', 'eq', 'is', 'order', 'limit', 'maybeSingle', 'single', 'insert', 'upsert', 'delete', 'update']
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
  }

  return { supabase, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
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

  it('sets the cookie only after the write is verified', async () => {
    const { supabase, calls } = buildSupabase({
      company_members: { single: { data: { company_id: 'company-2' } } },
      user_preferences: { single: { data: { active_company_id: 'company-2' } } },
    })

    await expect(setActiveCompany(supabase as never, 'user-1', 'company-2')).resolves.toBeUndefined()

    const upsert = calls.find((c) => c.table === 'user_preferences' && c.method === 'upsert')
    expect(upsert?.args[0]).toEqual({ user_id: 'user-1', active_company_id: 'company-2' })
    expect(mockCookieSet).toHaveBeenCalledTimes(1)
    expect(mockCookieSet).toHaveBeenCalledWith(
      'gnubok-company-id',
      'company-2',
      expect.objectContaining({ httpOnly: true, path: '/' }),
    )
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
