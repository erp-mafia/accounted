import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockCookieSet } = vi.hoisted(() => ({ mockCookieSet: vi.fn() }))

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ set: mockCookieSet })),
}))

import { setActiveCompany, CompanyContextError, getCompanyDisplayName } from '../context'

type CapturedCall = { table: string; method: string; args: unknown[] }

/**
 * Chainable Supabase mock (same approach as actions.test.ts): a chain method
 * terminates with `results[table][method]` when seeded, otherwise keeps
 * chaining. setActiveCompany ends both its queries on `.single()`, on
 * different tables, so seeding `single` per table drives each branch.
 */
function buildSupabase(results: Record<string, Record<string, { data?: unknown; error?: unknown }>>) {
  const calls: CapturedCall[] = []

  function makeChain(table: string) {
    const chain: Record<string, unknown> = {}
    const methods = ['select', 'eq', 'is', 'order', 'limit', 'maybeSingle', 'single', 'insert', 'upsert', 'delete', 'update']
    for (const m of methods) {
      chain[m] = (...args: unknown[]) => {
        calls.push({ table, method: m, args })
        const terminal = results[table]?.[m]
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
