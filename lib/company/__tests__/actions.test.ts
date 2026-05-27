import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  setActiveCompany: vi.fn().mockResolvedValue(undefined),
}))

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { createCompanyFromOnboarding } from '../actions'

const mockCreateClient = vi.mocked(createClient)
const mockCreateServiceClient = vi.mocked(createServiceClient)

/**
 * Build a service-role client mock. Seed `existingOrgNumber` when you want
 * the duplicate-org guard in createCompanyFromOnboarding to find a match.
 * Any other service-role query resolves to `{ data: null, error: null }`.
 */
function mockServiceClientForOrgNumber(existingOrgNumber?: string) {
  const serviceFrom = vi.fn().mockImplementation(() => {
    const chain: Record<string, unknown> = {}
    const methods = ['select', 'eq', 'is', 'in', 'order', 'limit', 'maybeSingle']
    for (const m of methods) {
      chain[m] = () => {
        if (m === 'maybeSingle') {
          return Promise.resolve({
            data: existingOrgNumber ? { id: 'other-company', name: 'Other AB' } : null,
            error: null,
          })
        }
        return chain
      }
    }
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
    return chain
  })
  mockCreateServiceClient.mockReturnValue({ from: serviceFrom } as never)
}

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
  // Default: no existing company with this org_number. Individual tests can
  // override by calling mockServiceClientForOrgNumber('...') inside the test.
  mockServiceClientForOrgNumber(undefined)
})

describe('createCompanyFromOnboarding — duplicate org_number guard', () => {
  it('refuses to create a company when the org number already exists', async () => {
    const { supabase, calls } = buildSupabase({
      user: { id: 'user-1' },
      rpcResults: {
        create_company_with_owner: { data: 'should-not-be-called' },
      },
    })
    mockCreateClient.mockResolvedValue(supabase as never)
    mockServiceClientForOrgNumber('5560125790') // pretend this org is already taken

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
    })

    expect(result.error).toBe('org_number_exists')
    expect(result.companyId).toBeUndefined()

    // Guard must short-circuit before the create RPC runs — otherwise we'd
    // leave a ghost company behind when the duplicate is detected.
    const rpcCreate = supabase.rpc.mock.calls.find(([name]) => name === 'create_company_with_owner')
    expect(rpcCreate).toBeUndefined()
    // And no company_settings upsert should have happened.
    expect(calls.find((c) => c.table === 'company_settings' && c.method === 'upsert')).toBeUndefined()
  })

  it('tolerates formatted org_numbers when detecting duplicates (hyphens/spaces stripped)', async () => {
    const { supabase } = buildSupabase({
      user: { id: 'user-1' },
      rpcResults: { create_company_with_owner: { data: 'x' } },
    })
    mockCreateClient.mockResolvedValue(supabase as never)
    mockServiceClientForOrgNumber('5560125790')

    const result = await createCompanyFromOnboarding({
      teamId: 'team-1',
      settings: {
        entity_type: 'aktiebolag',
        company_name: 'Acme AB',
        // User-typed format — the guard should still catch this as a duplicate.
        org_number: '556677-8899',
      },
      fiscalPeriod: {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        name: 'Räkenskapsår 2026',
      },
    })

    expect(result.error).toBe('org_number_exists')
  })

  it('normalizes 12-digit personnummer input down to the 10-digit canonical form', async () => {
    const { supabase } = buildSupabase({
      user: { id: 'user-1' },
      rpcResults: { create_company_with_owner: { data: 'x' } },
    })
    mockCreateClient.mockResolvedValue(supabase as never)
    // The existing company is stored as the 10-digit canonical form.
    mockServiceClientForOrgNumber('8001011231')

    const result = await createCompanyFromOnboarding({
      teamId: 'team-1',
      settings: {
        entity_type: 'enskild_firma',
        company_name: 'Anna EF',
        // User types full 12-digit personnummer with century prefix.
        org_number: '19800101-1231',
      },
      fiscalPeriod: {
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        name: 'Räkenskapsår 2026',
      },
    })

    // Should detect the duplicate despite the 12-digit input.
    expect(result.error).toBe('org_number_exists')
  })

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
    // Must NOT have reached the create RPC — otherwise we'd save a malformed
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

  it('fails closed when the duplicate lookup errors out (does not silently allow duplicates)', async () => {
    const { supabase } = buildSupabase({
      user: { id: 'user-1' },
      rpcResults: { create_company_with_owner: { data: 'x' } },
    })
    mockCreateClient.mockResolvedValue(supabase as never)

    // Seed a service client that errors on maybeSingle — simulating a DB
    // outage or RLS misconfiguration.
    mockCreateServiceClient.mockReturnValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'connection lost' },
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

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
    })

    // Must return a user-facing error, NOT silently proceed with creation.
    expect(result.companyId).toBeUndefined()
    expect(result.error).toBeTruthy()
    // And the create RPC must not have been called.
    const rpcCreate = supabase.rpc.mock.calls.find(([name]) => name === 'create_company_with_owner')
    expect(rpcCreate).toBeUndefined()
  })
})

describe('createCompanyFromOnboarding — TIC snapshot persistence', () => {
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
        // No org_number — exercises the path where the org_number UPDATE also
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

