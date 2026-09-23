import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

const deadlineMocks = vi.hoisted(() => ({
  regenerate: vi.fn().mockResolvedValue({ created: 1, deleted: 0 }),
}))

vi.mock('@/lib/tax/deadline-generator', () => ({
  regenerateTaxDeadlinesForUser: deadlineMocks.regenerate,
  toDeadlineSettings: vi.fn((settings: Record<string, unknown>) => settings),
}))

// Keep the real CompanyContextError so instanceof checks in switchCompany
// see the same class the tests throw.
vi.mock('@/lib/company/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/company/context')>()),
  setActiveCompany: vi.fn().mockResolvedValue(undefined),
}))

import { createClient } from '@/lib/supabase/server'
import { setActiveCompany, CompanyContextError } from '@/lib/company/context'
import { createCompanyFromOnboarding, switchCompany } from '../actions'

const mockCreateClient = vi.mocked(createClient)
const mockSetActiveCompany = vi.mocked(setActiveCompany)

type CapturedCall = { table: string; method: string; args: unknown[] }

/**
 * Builds a chainable Supabase mock that records every method call, allows
 * per-table result seeding, and returns a capture log the test can assert on.
 *
 * - `results[table][method]` (optional) is returned when the chain ends on
 *   that method. Chains otherwise resolve to `{ data: null, error: null }`.
 * - Unknown methods on the chain no-op and return the chain so callers can
 *   keep chaining freely.
 */
function buildSupabase(opts: {
  user: { id: string } | null
  results?: Record<string, Record<string, { data?: unknown; error?: unknown }>>
  rpcResults?: Record<string, { data?: unknown; error?: unknown }>
}) {
  const calls: CapturedCall[] = []
  const { user, results = {}, rpcResults = {} } = opts

  function makeChain(table: string) {
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
    }
    const chain: Record<string, unknown> = {}
    const methods = ['select', 'eq', 'is', 'in', 'order', 'limit', 'maybeSingle', 'single', 'insert', 'upsert', 'delete', 'update']
    for (const m of methods) {
      chain[m] = (...args: unknown[]) => {
        record(m, args)
        const canTerminate = results[table]?.[m]
        if (canTerminate) {
          return Promise.resolve({
            data: canTerminate.data ?? null,
            error: canTerminate.error ?? null,
          })
        }
        return chain
      }
    }
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
    return chain
  }

  const supabase = {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
    },
    from: vi.fn().mockImplementation((table: string) => makeChain(table)),
    rpc: vi.fn().mockImplementation((name: string) => {
      const result = rpcResults[name]
      if (result) {
        return Promise.resolve({ data: result.data ?? null, error: result.error ?? null })
      }
      return Promise.resolve({ data: null, error: null })
    }),
  }

  return { supabase, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
  deadlineMocks.regenerate.mockResolvedValue({ created: 1, deleted: 0 })
})

describe('switchCompany', () => {
  it('returns {} when the switch persists', async () => {
    const { supabase } = buildSupabase({ user: { id: 'user-1' } })
    mockCreateClient.mockResolvedValue(supabase as never)

    const result = await switchCompany('company-2')

    expect(result).toEqual({})
    expect(mockSetActiveCompany).toHaveBeenCalledWith(supabase, 'user-1', 'company-2')
  })

  it('returns Unauthorized when there is no user', async () => {
    const { supabase } = buildSupabase({ user: null })
    mockCreateClient.mockResolvedValue(supabase as never)

    const result = await switchCompany('company-2')

    expect(result).toEqual({ error: 'Unauthorized' })
    expect(mockSetActiveCompany).not.toHaveBeenCalled()
  })

  it('maps a membership failure to the not_member code', async () => {
    const { supabase } = buildSupabase({ user: { id: 'user-1' } })
    mockCreateClient.mockResolvedValue(supabase as never)
    mockSetActiveCompany.mockRejectedValueOnce(
      new CompanyContextError('User is not a member of this company', 'not_member'),
    )

    const result = await switchCompany('company-2')

    expect(result).toEqual({ error: 'not_member' })
  })

  it('maps a failed user_preferences write to persist_failed, not a permissions error (#701)', async () => {
    const { supabase } = buildSupabase({ user: { id: 'user-1' } })
    mockCreateClient.mockResolvedValue(supabase as never)
    mockSetActiveCompany.mockRejectedValueOnce(
      new CompanyContextError('Failed to persist active company: timeout', 'persist_failed'),
    )

    const result = await switchCompany('company-2')

    expect(result).toEqual({ error: 'persist_failed' })
  })

  it('maps unexpected errors to persist_failed rather than claiming missing access', async () => {
    const { supabase } = buildSupabase({ user: { id: 'user-1' } })
    mockCreateClient.mockResolvedValue(supabase as never)
    mockSetActiveCompany.mockRejectedValueOnce(new Error('cookies unavailable'))

    const result = await switchCompany('company-2')

    expect(result).toEqual({ error: 'persist_failed' })
  })
})

describe('createCompanyFromOnboarding: org_number validation', () => {
  it('rejects malformed org_numbers at the guard boundary', async () => {
    const { supabase } = buildSupabase({
      user: { id: 'user-1' },
      rpcResults: { create_company_with_owner: { data: 'x' } },
    })
    mockCreateClient.mockResolvedValue(supabase as never)

    const result = await createCompanyFromOnboarding({
      teamId: 'team-1',
      settings: {
        entity_type: 'aktiebolag',
        company_name: 'Broken AB',
        org_number: 'abc123', // not a 10- or 12-digit number
      },
      fiscalPeriod: {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        name: 'Räkenskapsår 2026',
      },
    })

    expect(result.error).toBe('org_number_invalid')
    // Must NOT have reached the create RPC: otherwise we'd save a malformed
    // org_number and poison SIE/SRU exports.
    const rpcCreate = supabase.rpc.mock.calls.find(([name]) => name === 'create_company_with_owner')
    expect(rpcCreate).toBeUndefined()
  })

  it('rejects right-length org_numbers with invalid Luhn check digit', async () => {
    const { supabase } = buildSupabase({
      user: { id: 'user-1' },
      rpcResults: { create_company_with_owner: { data: 'x' } },
    })
    mockCreateClient.mockResolvedValue(supabase as never)

    const result = await createCompanyFromOnboarding({
      teamId: 'team-1',
      settings: {
        entity_type: 'aktiebolag',
        company_name: 'Fake AB',
        // 10 digits but Luhn check digit is wrong (real Volvo is 5560125790;
        // the trailing 1 is an intentional off-by-one). Skatteverket SRU
        // validators and receiving SIE4 consumers would reject this, so we
        // refuse at the boundary.
        org_number: '5560125791',
      },
      fiscalPeriod: {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        name: 'Räkenskapsår 2026',
      },
    })

    expect(result.error).toBe('org_number_invalid')
    const rpcCreate = supabase.rpc.mock.calls.find(([name]) => name === 'create_company_with_owner')
    expect(rpcCreate).toBeUndefined()
  })
})

describe('createCompanyFromOnboarding: byrå team gating (WL-15)', () => {
  const baseParams = {
    settings: {
      entity_type: 'aktiebolag' as const,
      company_name: 'Klient AB',
    },
    fiscalPeriod: {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      name: 'Räkenskapsår 2026',
    },
  }

  it('refuses a plain byrå MEMBER (creation is +1 on the byrå invoice)', async () => {
    const { supabase } = buildSupabase({
      user: { id: 'user-1' },
      results: {
        teams: { maybeSingle: { data: { kind: 'byra' } } },
        team_members: { maybeSingle: { data: { role: 'member' } } },
      },
      rpcResults: { create_company_with_owner: { data: 'should-not-happen' } },
    })
    mockCreateClient.mockResolvedValue(supabase as never)

    const result = await createCompanyFromOnboarding({
      teamId: 'byra-team',
      ...baseParams,
    })

    expect(result.error).toBe(
      'Endast byråns ägare och administratörer kan skapa klientbolag.',
    )
    const rpcCreate = supabase.rpc.mock.calls.find(
      ([name]) => name === 'create_company_with_owner',
    )
    expect(rpcCreate).toBeUndefined()
  })

  it('lets a byrå ADMIN create, with the explicit byrå team binding', async () => {
    const { supabase } = buildSupabase({
      user: { id: 'user-1' },
      results: {
        teams: { maybeSingle: { data: { kind: 'byra' } } },
        team_members: { maybeSingle: { data: { role: 'admin' } } },
      },
      rpcResults: {
        create_company_with_owner: { data: 'client-company-id' },
        seed_chart_of_accounts: { data: null },
      },
    })
    mockCreateClient.mockResolvedValue(supabase as never)

    const result = await createCompanyFromOnboarding({
      teamId: 'byra-team',
      ...baseParams,
    })

    // Response shape: the created company id, no error.
    expect(result).toEqual({ companyId: 'client-company-id' })

    // Team binding present: the RPC received the byrå team explicitly
    // (never ensure_user_team arbitrariness, WL-08/WL-15).
    const rpcCreate = supabase.rpc.mock.calls.find(
      ([name]) => name === 'create_company_with_owner',
    )
    expect(rpcCreate?.[1]).toMatchObject({ p_team_id: 'byra-team' })
  })

  it('keeps personal-team creation untouched (no role gate)', async () => {
    const { supabase } = buildSupabase({
      user: { id: 'user-1' },
      results: {
        teams: { maybeSingle: { data: { kind: 'personal' } } },
      },
      rpcResults: {
        create_company_with_owner: { data: 'personal-company-id' },
        seed_chart_of_accounts: { data: null },
      },
    })
    mockCreateClient.mockResolvedValue(supabase as never)

    const result = await createCompanyFromOnboarding({
      teamId: 'personal-team',
      ...baseParams,
    })

    expect(result).toEqual({ companyId: 'personal-company-id' })
  })
})

describe('createCompanyFromOnboarding: TIC snapshot persistence', () => {
  it('persists the supplied ticLookup to companies.tic_snapshot', async () => {
    const { supabase, calls } = buildSupabase({
      user: { id: 'user-1' },
      rpcResults: {
        create_company_with_owner: { data: 'new-company-id' },
        seed_chart_of_accounts: { data: null },
      },
    })
    mockCreateClient.mockResolvedValue(supabase as never)

    const ticLookup = {
      companyName: 'Acme AB',
      isCeased: false,
      address: { street: 'Storgatan 1', postalCode: '11122', city: 'Stockholm' },
      registration: { fTax: true, vat: true },
      bankAccounts: [],
      email: null,
      phone: null,
      sniCodes: [{ code: '62010', name: 'Dataprogrammering' }],
      fiscalYear: { startMonthDay: '01-01', endMonthDay: '12-31' },
      legalEntityType: 'AB',
      registrationDate: 0,
    }

    const result = await createCompanyFromOnboarding({
      teamId: 'team-1',
      settings: {
        entity_type: 'aktiebolag',
        company_name: 'Acme AB',
        org_number: '5560125790',
      },
      fiscalPeriod: {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        name: 'Räkenskapsår 2026',
      },
      ticLookup,
    })

    expect(result.companyId).toBe('new-company-id')

    // The lookup must have been UPDATEd onto the freshly-created company row.
    // Two updates run on `companies`: one for org_number, one for tic_snapshot.
    const companyUpdates = calls.filter(
      (c) => c.table === 'companies' && c.method === 'update',
    )
    const snapshotUpdate = companyUpdates.find((c) => {
      const payload = c.args[0] as Record<string, unknown>
      return 'tic_snapshot' in payload
    })
    expect(snapshotUpdate).toBeDefined()
    const payload = snapshotUpdate!.args[0] as Record<string, unknown>
    expect(payload.tic_snapshot).toEqual(ticLookup)
    expect(payload.tic_snapshot_fetched_at).toBeDefined()
    expect(deadlineMocks.regenerate).toHaveBeenCalledWith(
      supabase,
      'new-company-id',
      expect.objectContaining({ entity_type: 'aktiebolag' }),
    )
  })

  it('rolls back company creation when automatic deadlines cannot be created', async () => {
    const { supabase, calls } = buildSupabase({
      user: { id: 'user-1' },
      rpcResults: {
        create_company_with_owner: { data: 'new-company-id' },
        seed_chart_of_accounts: { data: null },
      },
    })
    mockCreateClient.mockResolvedValue(supabase as never)
    deadlineMocks.regenerate.mockRejectedValueOnce(new Error('deadline insert failed'))

    const result = await createCompanyFromOnboarding({
      teamId: 'team-1',
      settings: {
        entity_type: 'aktiebolag',
        company_name: 'Acme AB',
      },
      fiscalPeriod: {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        name: 'Räkenskapsår 2026',
      },
    })

    expect(result).toEqual({ error: 'Kunde inte skapa skattedeadlines. Försök igen.' })
    expect(calls).toContainEqual(expect.objectContaining({ table: 'companies', method: 'delete' }))
    expect(mockSetActiveCompany).not.toHaveBeenCalled()
  })

  it('skips the snapshot update when no ticLookup is supplied (manual signup)', async () => {
    const { supabase, calls } = buildSupabase({
      user: { id: 'user-1' },
      rpcResults: {
        create_company_with_owner: { data: 'new-company-id' },
        seed_chart_of_accounts: { data: null },
      },
    })
    mockCreateClient.mockResolvedValue(supabase as never)

    const result = await createCompanyFromOnboarding({
      teamId: 'team-1',
      settings: {
        entity_type: 'aktiebolag',
        company_name: 'Manual AB',
        // No org_number: exercises the path where the org_number UPDATE also
        // doesn't run, so we can isolate the no-snapshot guarantee.
      },
      fiscalPeriod: {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        name: 'Räkenskapsår 2026',
      },
      // ticLookup intentionally omitted
    })

    expect(result.companyId).toBe('new-company-id')

    // No update touched tic_snapshot at all.
    const snapshotUpdate = calls.find((c) => {
      if (c.table !== 'companies' || c.method !== 'update') return false
      const payload = c.args[0] as Record<string, unknown>
      return 'tic_snapshot' in payload
    })
    expect(snapshotUpdate).toBeUndefined()
  })

  it('does NOT call the heavy /profile endpoint at signup (regression: was 13 calls/signup)', async () => {
    // The signup path used to call ensureTicSnapshot which fetches /profile.
    // We removed it because it timed out 100% of the time, costing 13 Lens
    // calls each. This test prevents anyone from re-adding it by checking
    // that fetch is never invoked during the action.
    vi.stubGlobal('fetch', vi.fn())

    const { supabase } = buildSupabase({
      user: { id: 'user-1' },
      rpcResults: {
        create_company_with_owner: { data: 'new-company-id' },
        seed_chart_of_accounts: { data: null },
      },
    })
    mockCreateClient.mockResolvedValue(supabase as never)

    await createCompanyFromOnboarding({
      teamId: 'team-1',
      settings: {
        entity_type: 'aktiebolag',
        company_name: 'Acme AB',
        org_number: '5560125790',
      },
      fiscalPeriod: {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        name: 'Räkenskapsår 2026',
      },
    })

    expect(fetch).not.toHaveBeenCalled()
  })
})

