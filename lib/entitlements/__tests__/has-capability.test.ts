import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  hasCapability,
  requireCapability,
  capabilityBlockedResponse,
  getCompanyIdsWithCapability,
  getCompanyEntitlements,
} from '../has-capability'
import { CAPABILITY, CONNECTOR_CAPABILITIES, PAID_CAPABILITIES } from '../keys'

/**
 * Per-table mock: each table resolves to its own configured result, so a
 * function that queries several tables in one call (companies → capability_grants
 * → company_capability_config) gets the right answer per table. Any chained
 * method returns the chain; awaiting it (or .maybeSingle()/.or()) resolves to
 * the table's result.
 */
type TableResult = { data: unknown; error?: unknown }
function makeSupabase(byTable: Record<string, TableResult>): SupabaseClient {
  const chainFor = (table: string) => {
    const result = byTable[table] ?? { data: null, error: null }
    const chain: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) =>
              resolve({ data: result.data ?? null, error: result.error ?? null })
          }
          return () => chain
        },
      },
    )
    return chain
  }
  return { from: (t: string) => chainFor(t) } as unknown as SupabaseClient
}

/**
 * Same per-table mock, but every chained call is recorded so a test can
 * assert WHICH filters a query applied (the mock itself ignores them).
 */
type RecordedCall = { table: string; method: string; args: unknown[] }
function makeRecordingSupabase(byTable: Record<string, TableResult>, calls: RecordedCall[]): SupabaseClient {
  const chainFor = (table: string) => {
    const result = byTable[table] ?? { data: null, error: null }
    const chain: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) =>
              resolve({ data: result.data ?? null, error: result.error ?? null })
          }
          return (...args: unknown[]) => {
            calls.push({ table, method: String(prop), args })
            return chain
          }
        },
      },
    )
    return chain
  }
  return { from: (t: string) => chainFor(t) } as unknown as SupabaseClient
}
const sourceFilters = (calls: RecordedCall[]) =>
  calls.filter((c) => c.table === 'capability_grants' && c.method === 'eq' && c.args[0] === 'source')

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('hasCapability', () => {
  it('returns true on self-hosted without touching the DB', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    const supabase = makeSupabase({}) // would resolve to null/false if queried
    expect(await hasCapability(supabase, '11111111-1111-4111-8111-111111111111', CAPABILITY.ai)).toBe(true)
  })

  it('development bypasses the gate (all-on) so gated features are testable without a subscription', async () => {
    // This is WHY a lapsed company still sees paid surfaces under `npm run dev`.
    vi.stubEnv('NODE_ENV', 'development')
    const supabase = makeSupabase({}) // no grant: would be false if the gate ran
    expect(await hasCapability(supabase, '11111111-1111-4111-8111-111111111111', CAPABILITY.ai)).toBe(true)
  })

  it('FORCE_PAYWALL=true activates the real gate in development (fail-closed on an expired grant)', async () => {
    vi.stubEnv('NODE_ENV', 'development') // would otherwise bypass
    vi.stubEnv('FORCE_PAYWALL', 'true')
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: { data: [{ expires_at: iso(-60_000) }] }, // expired
    })
    expect(await hasCapability(supabase, '11111111-1111-4111-8111-111111111111', CAPABILITY.ai)).toBe(false)
  })

  it('FORCE_PAYWALL never overrides self-hosted (stays all-on)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    vi.stubEnv('FORCE_PAYWALL', 'true')
    const supabase = makeSupabase({}) // would resolve null/false if queried
    expect(await hasCapability(supabase, '11111111-1111-4111-8111-111111111111', CAPABILITY.ai)).toBe(true)
  })

  it('returns true for an unexpired company-scoped grant', async () => {
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: { data: [{ expires_at: iso(60_000) }] },
      company_capability_config: { data: null },
    })
    expect(await hasCapability(supabase, '11111111-1111-4111-8111-111111111111', CAPABILITY.ai)).toBe(true)
  })

  it('treats a null expiry as never-expiring (true)', async () => {
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: { data: [{ expires_at: null }] },
      company_capability_config: { data: null },
    })
    expect(await hasCapability(supabase, '11111111-1111-4111-8111-111111111111', CAPABILITY.bank_sync)).toBe(true)
  })

  it('fails closed when there is no grant', async () => {
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: { data: [] },
    })
    expect(await hasCapability(supabase, '11111111-1111-4111-8111-111111111111', CAPABILITY.ai)).toBe(false)
  })

  it('fails closed when the only grant is expired', async () => {
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: { data: [{ expires_at: iso(-60_000) }] },
    })
    expect(await hasCapability(supabase, '11111111-1111-4111-8111-111111111111', CAPABILITY.ai)).toBe(false)
  })

  it('honours a firm/team-scoped grant (cascades to the client company)', async () => {
    const supabase = makeSupabase({
      companies: { data: { team_id: '22222222-2222-4222-8222-222222222222' } },
      capability_grants: { data: [{ expires_at: iso(60_000) }] }, // grant lives on the team
      company_capability_config: { data: null },
    })
    expect(await hasCapability(supabase, '11111111-1111-4111-8111-111111111111', CAPABILITY.skatteverket)).toBe(true)
  })

  it('returns false when entitled but explicitly disabled (enablement axis)', async () => {
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: { data: [{ expires_at: null }] },
      company_capability_config: { data: { enabled: false } },
    })
    expect(await hasCapability(supabase, '11111111-1111-4111-8111-111111111111', CAPABILITY.ai)).toBe(false)
  })

  it('fails closed when the grants query errors', async () => {
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: { data: null, error: { message: 'boom' } },
    })
    expect(await hasCapability(supabase, '11111111-1111-4111-8111-111111111111', CAPABILITY.ai)).toBe(false)
  })
})

describe('getCompanyIdsWithCapability', () => {
  const directCompanyId = '11111111-1111-4111-8111-111111111111'
  const firmCompanyId = '22222222-2222-4222-8222-222222222222'
  const expiredCompanyId = '33333333-3333-4333-8333-333333333333'
  const disabledCompanyId = '44444444-4444-4444-8444-444444444444'
  const teamId = '55555555-5555-4555-8555-555555555555'

  it('resolves direct and firm grants before excluding expired and disabled companies', async () => {
    const supabase = makeSupabase({
      companies: {
        data: [
          { id: directCompanyId, team_id: null },
          { id: firmCompanyId, team_id: teamId },
          { id: expiredCompanyId, team_id: null },
          { id: disabledCompanyId, team_id: null },
        ],
      },
      capability_grants: {
        data: [
          { company_id: directCompanyId, team_id: null, expires_at: null },
          { company_id: null, team_id: teamId, expires_at: iso(60_000) },
          { company_id: expiredCompanyId, team_id: null, expires_at: iso(-60_000) },
          { company_id: disabledCompanyId, team_id: null, expires_at: null },
        ],
      },
      company_capability_config: { data: [{ company_id: disabledCompanyId }] },
    })

    const result = await getCompanyIdsWithCapability(
      supabase,
      [directCompanyId, firmCompanyId, expiredCompanyId, disabledCompanyId],
      CAPABILITY.bank_sync,
    )

    expect([...result].sort()).toEqual([directCompanyId, firmCompanyId].sort())
  })

  it('returns every valid requested company when the paywall is bypassed (self-hosted, local capability)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    const supabase = makeSupabase({})

    // A local capability: self-hosted is all-on without touching the DB. The
    // connector capabilities (e.g. skatteverket) are covered in the
    // self-hosted connector block below: they need a grant even here.
    const result = await getCompanyIdsWithCapability(
      supabase,
      [directCompanyId, directCompanyId, 'not-a-uuid'],
      CAPABILITY.ai,
    )

    expect([...result]).toEqual([directCompanyId])
  })

  it('throws on a database error so a cron run cannot silently skip every payer', async () => {
    const supabase = makeSupabase({
      companies: { data: null, error: { message: 'connection reset' } },
      company_capability_config: { data: [] },
    })

    await expect(
      getCompanyIdsWithCapability(supabase, [directCompanyId], CAPABILITY.bank_sync),
    ).rejects.toThrow('Failed to resolve capability company scopes: connection reset')
  })
})

describe('requireCapability', () => {
  it('returns null (proceed) when the company has the capability', async () => {
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: { data: [{ expires_at: null }] },
      company_capability_config: { data: null },
    })
    expect(await requireCapability(supabase, '11111111-1111-4111-8111-111111111111', CAPABILITY.ai)).toBeNull()
  })

  it('returns a 403 capability_blocked response when missing', async () => {
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: { data: [] },
    })
    const res = await requireCapability(supabase, '11111111-1111-4111-8111-111111111111', CAPABILITY.ai)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
    const body = await res!.json()
    expect(body.capability_blocked).toBe(true)
    expect(body.capability).toBe(CAPABILITY.ai)
  })
})

describe('getCompanyEntitlements', () => {
  const companyId = '11111111-1111-4111-8111-111111111111'

  it('reports the trial expiry while the trial is the only source of access', async () => {
    const expiry = iso(10 * 24 * 3600 * 1000)
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: {
        data: [
          { capability_key: CAPABILITY.ai, expires_at: expiry, source: 'trial' },
          { capability_key: CAPABILITY.bank_sync, expires_at: expiry, source: 'trial' },
        ],
      },
      company_capability_config: { data: [] },
    })
    const result = await getCompanyEntitlements(supabase, companyId)
    expect(result.trialEndsAt).toBe(expiry)
    expect(result.capabilities).toContain(CAPABILITY.ai)
    expect(result.capabilities).toContain(CAPABILITY.bank_sync)
    expect(result.entitlementState).toBe('trial')
    expect(result.trialExpiredAt).toBeNull()
  })

  it('skips the companies lookup and still scopes grants to the team when teamId is supplied', async () => {
    const teamId = '22222222-2222-4222-8222-222222222222'
    const base = makeSupabase({
      // Deliberately wrong: if the lookup ran, the team scope would be lost.
      companies: { data: { team_id: null } },
      capability_grants: {
        data: [{ capability_key: CAPABILITY.ai, expires_at: null, source: 'stripe' }],
      },
      company_capability_config: { data: [] },
    })
    const tables: string[] = []
    const supabase = {
      from: (table: string) => {
        tables.push(table)
        return (base.from as (t: string) => unknown)(table)
      },
    } as unknown as SupabaseClient
    const result = await getCompanyEntitlements(supabase, companyId, { teamId })
    expect(result.capabilities).toContain(CAPABILITY.ai)
    expect(result.entitlementState).toBe('paid')
    expect(tables).not.toContain('companies')
    expect(tables).toContain('capability_grants')
  })

  it('hides the trial once a non-trial grant is active (converted customer)', async () => {
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: {
        data: [
          { capability_key: CAPABILITY.ai, expires_at: iso(10 * 24 * 3600 * 1000), source: 'trial' },
          { capability_key: CAPABILITY.ai, expires_at: null, source: 'stripe' },
        ],
      },
      company_capability_config: { data: [] },
    })
    const result = await getCompanyEntitlements(supabase, companyId)
    expect(result.trialEndsAt).toBeNull()
    expect(result.capabilities).toContain(CAPABILITY.ai)
    expect(result.entitlementState).toBe('paid')
    expect(result.trialExpiredAt).toBeNull()
  })

  it('reports trial_expired with the lapsed expiry after the trial lapsed', async () => {
    const expiredEarlier = iso(-120_000)
    const expiredLatest = iso(-60_000)
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: {
        data: [
          { capability_key: CAPABILITY.ai, expires_at: expiredLatest, source: 'trial' },
          { capability_key: CAPABILITY.bank_sync, expires_at: expiredEarlier, source: 'trial' },
        ],
      },
    })
    const result = await getCompanyEntitlements(supabase, companyId)
    expect(result.trialEndsAt).toBeNull()
    expect(result.capabilities).toEqual([])
    expect(result.entitlementState).toBe('trial_expired')
    // Latest expiry across the trial rows, even though all are expired.
    expect(result.trialExpiredAt).toBe(expiredLatest)
  })

  it('reports lapsed_subscription for a churned payer (cancelled subscription, expired trial rows)', async () => {
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: {
        data: [{ capability_key: CAPABILITY.ai, expires_at: iso(-60_000), source: 'trial' }],
      },
      company_subscriptions: { data: { status: 'canceled' } },
    })
    const result = await getCompanyEntitlements(supabase, companyId)
    expect(result.entitlementState).toBe('lapsed_subscription')
    expect(result.trialEndsAt).toBeNull()
    expect(result.capabilities).toEqual([])
  })

  it('a live subscription status never marks a company lapsed', async () => {
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: {
        data: [{ capability_key: CAPABILITY.ai, expires_at: iso(-60_000), source: 'trial' }],
      },
      company_subscriptions: { data: { status: 'active' } },
    })
    const result = await getCompanyEntitlements(supabase, companyId)
    expect(result.entitlementState).toBe('trial_expired')
  })

  it('reports none when no grant rows exist at all', async () => {
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: { data: [] },
    })
    const result = await getCompanyEntitlements(supabase, companyId)
    expect(result.entitlementState).toBe('none')
    expect(result.trialEndsAt).toBeNull()
    expect(result.trialExpiredAt).toBeNull()
    expect(result.capabilities).toEqual([])
  })

  it('self-hosted holds every local paid capability with no trial countdown; connector keys need a grant', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: { data: [] },
      company_capability_config: { data: [] },
    })
    const result = await getCompanyEntitlements(supabase, companyId)
    expect(result.trialEndsAt).toBeNull()
    expect(result.capabilities).toEqual(PAID_CAPABILITIES.filter((k) => !CONNECTOR_CAPABILITIES.includes(k)))
    // No trial exists on a self-host: 'none' until a connector grant is active.
    expect(result.entitlementState).toBe('none')
  })

  it('dev bypass on a self-host still holds everything (connector keys included)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    vi.stubEnv('NODE_ENV', 'development')
    const result = await getCompanyEntitlements(makeSupabase({}), companyId)
    expect(result.capabilities).toEqual([...PAID_CAPABILITIES])
    expect(result.entitlementState).toBe('paid')
  })
})

describe('capabilityBlockedResponse', () => {
  it('returns a bilingual 403 carrying the capability key', async () => {
    const res = capabilityBlockedResponse(CAPABILITY.bank_sync)
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBeTruthy()
    expect(body.error_en).toBeTruthy()
    expect(body.capability_blocked).toBe(true)
    expect(body.capability).toBe(CAPABILITY.bank_sync)
  })
})

/**
 * Sovereign self-host partition (plan WS3 PR3). Local capabilities stay all-on
 * on a self-host; the CONNECTOR_CAPABILITIES (bank sync, Skatteverket, org
 * lookup, migration: services Accounted operates) fall through to the grant
 * lookup, where the connector sync writes source='connector' rows. Hosted
 * behaviour is untouched by construction (the tests above still pass).
 */
describe('self-hosted connector capabilities', () => {
  const COMPANY = '11111111-1111-4111-8111-111111111111'

  it('keeps every local capability all-on without touching the DB', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    const supabase = makeSupabase({})
    for (const key of PAID_CAPABILITIES.filter((k) => !CONNECTOR_CAPABILITIES.includes(k))) {
      expect(await hasCapability(supabase, COMPANY, key), key).toBe(true)
    }
  })

  it('gates a connector capability on a grant (true with an active connector grant)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: { data: [{ expires_at: iso(60_000) }] },
      company_capability_config: { data: null },
    })
    expect(await hasCapability(supabase, COMPANY, CAPABILITY.bank_sync)).toBe(true)
  })

  it('fails closed for a connector capability without a grant, and once the grant expired (offline grace over)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    expect(
      await hasCapability(
        makeSupabase({ companies: { data: { team_id: null } }, capability_grants: { data: [] } }),
        COMPANY,
        CAPABILITY.skatteverket,
      ),
    ).toBe(false)
    expect(
      await hasCapability(
        makeSupabase({
          companies: { data: { team_id: null } },
          capability_grants: { data: [{ expires_at: iso(-60_000) }] },
        }),
        COMPANY,
        CAPABILITY.org_lookup,
      ),
    ).toBe(false)
  })

  it('keeps the dev bypass all-on on a self-host, connector capabilities included', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    vi.stubEnv('NODE_ENV', 'development')
    expect(await hasCapability(makeSupabase({}), COMPANY, CAPABILITY.migration)).toBe(true)
  })

  it('lets FORCE_PAYWALL run the real gate for connector capabilities but never for local ones', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('FORCE_PAYWALL', 'true')
    const noGrant = makeSupabase({ companies: { data: { team_id: null } }, capability_grants: { data: [] } })
    expect(await hasCapability(noGrant, COMPANY, CAPABILITY.bank_sync)).toBe(false)
    expect(await hasCapability(noGrant, COMPANY, CAPABILITY.ai)).toBe(true)
  })

  it('bulk resolution honours the same partition', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    const supabase = makeSupabase({
      companies: { data: [{ id: COMPANY, team_id: null }] },
      company_capability_config: { data: [] },
      capability_grants: { data: [] },
    })
    expect(await getCompanyIdsWithCapability(supabase, [COMPANY], CAPABILITY.ai)).toEqual(new Set([COMPANY]))
    expect(await getCompanyIdsWithCapability(supabase, [COMPANY], CAPABILITY.bank_sync)).toEqual(new Set())
  })

  it('getCompanyEntitlements reports local paid keys plus active connector keys, state paid/none, no trial copy', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    const localPaid = PAID_CAPABILITIES.filter((k) => !CONNECTOR_CAPABILITIES.includes(k))

    const without = await getCompanyEntitlements(
      makeSupabase({ companies: { data: { team_id: null } }, capability_grants: { data: [] }, company_capability_config: { data: [] } }),
      COMPANY,
    )
    expect(without.capabilities).toEqual(localPaid)
    expect(without.entitlementState).toBe('none')
    expect(without.trialEndsAt).toBeNull()
    expect(without.trialExpiredAt).toBeNull()

    const withGrant = await getCompanyEntitlements(
      makeSupabase({
        companies: { data: { team_id: null } },
        capability_grants: { data: [{ capability_key: 'bank_sync', expires_at: iso(60_000), source: 'connector' }] },
        company_capability_config: { data: [] },
      }),
      COMPANY,
    )
    expect(withGrant.capabilities).toEqual(PAID_CAPABILITIES.filter((k) => localPaid.includes(k) || k === CAPABILITY.bank_sync))
    expect(withGrant.entitlementState).toBe('paid')
  })

  // The dashboard layout passes teamId, which moves the grants read into the
  // early wave (#1946). That call site and the fallback read must narrow to
  // the same key list and carry the same source filter, or the self-host
  // partition silently reads every paid key on the layout path. The in-loop
  // source check masks a lost narrowing, so this pins the query itself.
  it('getCompanyEntitlements with teamId narrows the early grants read to connector keys and source=connector on a self-host', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    const calls: RecordedCall[] = []
    const supabase = makeRecordingSupabase(
      {
        // Deliberately wrong: the lookup must not run when teamId is supplied.
        companies: { data: { team_id: null } },
        capability_grants: { data: [] },
        company_capability_config: { data: [] },
        company_subscriptions: { data: null },
      },
      calls,
    )
    const result = await getCompanyEntitlements(supabase, COMPANY, { teamId: null })
    const keyFilters = calls.filter((c) => c.table === 'capability_grants' && c.method === 'in')
    expect(keyFilters.map((c) => c.args)).toEqual([
      ['capability_key', PAID_CAPABILITIES.filter((k) => CONNECTOR_CAPABILITIES.includes(k))],
    ])
    expect(sourceFilters(calls).map((c) => c.args)).toEqual([['source', 'connector']])
    expect(calls.map((c) => c.table)).not.toContain('companies')
    expect(result.capabilities).toEqual(PAID_CAPABILITIES.filter((k) => !CONNECTOR_CAPABILITIES.includes(k)))
    expect(result.entitlementState).toBe('none')
  })

  it('getCompanyEntitlements with teamId reads every paid key and every source on hosted', async () => {
    const TEAM = '55555555-5555-4555-8555-555555555555'
    const calls: RecordedCall[] = []
    const supabase = makeRecordingSupabase(
      {
        companies: { data: { team_id: null } },
        capability_grants: { data: [] },
        company_capability_config: { data: [] },
        company_subscriptions: { data: null },
      },
      calls,
    )
    await getCompanyEntitlements(supabase, COMPANY, { teamId: TEAM })
    const keyFilters = calls.filter((c) => c.table === 'capability_grants' && c.method === 'in')
    expect(keyFilters.map((c) => c.args)).toEqual([['capability_key', PAID_CAPABILITIES]])
    expect(sourceFilters(calls)).toHaveLength(0)
    expect(calls.map((c) => c.table)).not.toContain('companies')
  })

  // The trial-seed trigger writes source='trial' rows for bank_sync and
  // skatteverket on every company insert, self-hosts included. Only the
  // connector sync's own rows may unlock a connector capability there.
  it('reads only source=connector grants on a self-host, so the trial seed cannot unlock a connector', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    const calls: RecordedCall[] = []
    const supabase = makeRecordingSupabase(
      {
        companies: { data: { team_id: null } },
        capability_grants: { data: [{ expires_at: iso(60_000) }] },
        company_capability_config: { data: null },
      },
      calls,
    )
    expect(await hasCapability(supabase, COMPANY, CAPABILITY.bank_sync)).toBe(true)
    expect(sourceFilters(calls).map((c) => c.args)).toEqual([['source', 'connector']])
  })

  it('bulk resolution applies the source=connector filter to both the company and the firm grant reads', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    const TEAM = '55555555-5555-4555-8555-555555555555'
    const calls: RecordedCall[] = []
    const supabase = makeRecordingSupabase(
      {
        companies: { data: [{ id: COMPANY, team_id: TEAM }] },
        company_capability_config: { data: [] },
        capability_grants: { data: [] },
      },
      calls,
    )
    await getCompanyIdsWithCapability(supabase, [COMPANY], CAPABILITY.skatteverket)
    expect(sourceFilters(calls).map((c) => c.args)).toEqual([
      ['source', 'connector'],
      ['source', 'connector'],
    ])
  })

  it('hosted keeps reading grants of every source (trial, stripe, comp, manual): no connector filter', async () => {
    const calls: RecordedCall[] = []
    const supabase = makeRecordingSupabase(
      {
        companies: { data: { team_id: null } },
        capability_grants: { data: [{ expires_at: iso(60_000) }] },
        company_capability_config: { data: null },
      },
      calls,
    )
    expect(await hasCapability(supabase, COMPANY, CAPABILITY.bank_sync)).toBe(true)
    expect(sourceFilters(calls)).toHaveLength(0)

    const bulkCalls: RecordedCall[] = []
    await getCompanyIdsWithCapability(
      makeRecordingSupabase(
        {
          companies: { data: [{ id: COMPANY, team_id: null }] },
          company_capability_config: { data: [] },
          capability_grants: { data: [] },
        },
        bulkCalls,
      ),
      [COMPANY],
      CAPABILITY.bank_sync,
    )
    expect(sourceFilters(bulkCalls)).toHaveLength(0)
  })

  it('getCompanyEntitlements ignores trial-seeded connector rows on a self-host', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    const localPaid = PAID_CAPABILITIES.filter((k) => !CONNECTOR_CAPABILITIES.includes(k))

    const seededOnly = await getCompanyEntitlements(
      makeSupabase({
        companies: { data: { team_id: null } },
        capability_grants: {
          data: [
            { capability_key: 'bank_sync', expires_at: iso(60_000), source: 'trial' },
            { capability_key: 'skatteverket', expires_at: iso(60_000), source: 'trial' },
          ],
        },
        company_capability_config: { data: [] },
      }),
      COMPANY,
    )
    expect(seededOnly.capabilities).toEqual(localPaid)
    expect(seededOnly.entitlementState).toBe('none')
    expect(seededOnly.trialEndsAt).toBeNull()
    expect(seededOnly.trialExpiredAt).toBeNull()

    const mixed = await getCompanyEntitlements(
      makeSupabase({
        companies: { data: { team_id: null } },
        capability_grants: {
          data: [
            { capability_key: 'bank_sync', expires_at: iso(60_000), source: 'trial' },
            { capability_key: 'skatteverket', expires_at: iso(60_000), source: 'connector' },
          ],
        },
        company_capability_config: { data: [] },
      }),
      COMPANY,
    )
    expect(mixed.capabilities).toEqual(
      PAID_CAPABILITIES.filter((k) => localPaid.includes(k) || k === CAPABILITY.skatteverket),
    )
    expect(mixed.entitlementState).toBe('paid')
  })
})

/**
 * Own-credentials seam: a self-host that serves an upstream from its OWN
 * credentials (its own Enable Banking registration, its own Skatteverket
 * client) is never connector-gated for it. Without this, upgrading an
 * own-credentials self-host would silently kill working bank/SKV integrations
 * (the 2026-08-17 folded-flag incident, recreated). Hosted never reaches the
 * seam: isBypassedFor checks isSelfHosted() first.
 */
describe('self-hosted own-credentials seam', () => {
  const COMPANY = '11111111-1111-4111-8111-111111111111'
  const CRED_VARS = [
    'ENABLE_BANKING_APP_ID',
    'ENABLE_BANKING_APP_ID_PRODUCTION',
    'ENABLE_BANKING_PRIVATE_KEY',
    'ENABLE_BANKING_PRIVATE_KEY_PRODUCTION',
    'SKATTEVERKET_OAUTH2_CLIENT_ID',
    'SKATTEVERKET_APIGW_CLIENT_ID',
  ] as const
  const stubNoOwnCredentials = () => {
    for (const v of CRED_VARS) vi.stubEnv(v, '')
  }

  it('own EB credentials keep bank_sync all-on without touching the DB (FORCE_PAYWALL included)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    vi.stubEnv('FORCE_PAYWALL', 'true')
    stubNoOwnCredentials()
    vi.stubEnv('ENABLE_BANKING_APP_ID', 'own-app-id')
    const supabase = makeSupabase({}) // would resolve null/false if queried
    expect(await hasCapability(supabase, COMPANY, CAPABILITY.bank_sync)).toBe(true)
    // skatteverket has no own credentials here: still gated.
    expect(
      await hasCapability(
        makeSupabase({ companies: { data: { team_id: null } }, capability_grants: { data: [] } }),
        COMPANY,
        CAPABILITY.skatteverket,
      ),
    ).toBe(false)
  })

  it('own SKV credentials keep skatteverket all-on (either client id variant)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    stubNoOwnCredentials()
    vi.stubEnv('SKATTEVERKET_APIGW_CLIENT_ID', 'own-client')
    expect(await hasCapability(makeSupabase({}), COMPANY, CAPABILITY.skatteverket)).toBe(true)
    vi.stubEnv('SKATTEVERKET_APIGW_CLIENT_ID', '')
    vi.stubEnv('SKATTEVERKET_OAUTH2_CLIENT_ID', 'own-oauth-client')
    expect(await hasCapability(makeSupabase({}), COMPANY, CAPABILITY.skatteverket)).toBe(true)
  })

  it('own credentials never unlock org_lookup or migration (no own-credentials form exists)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    stubNoOwnCredentials()
    vi.stubEnv('ENABLE_BANKING_APP_ID', 'own-app-id')
    vi.stubEnv('SKATTEVERKET_APIGW_CLIENT_ID', 'own-client')
    const noGrant = makeSupabase({ companies: { data: { team_id: null } }, capability_grants: { data: [] } })
    expect(await hasCapability(noGrant, COMPANY, CAPABILITY.org_lookup)).toBe(false)
    expect(await hasCapability(noGrant, COMPANY, CAPABILITY.migration)).toBe(false)
  })

  it('hosted behaviour is unchanged by credential env vars (gate still runs)', async () => {
    stubNoOwnCredentials()
    vi.stubEnv('ENABLE_BANKING_APP_ID', 'hosted-always-has-these')
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: { data: [{ expires_at: iso(-60_000) }] }, // expired
    })
    expect(await hasCapability(supabase, COMPANY, CAPABILITY.bank_sync)).toBe(false)
  })

  it('bulk resolution honours the seam', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    stubNoOwnCredentials()
    vi.stubEnv('ENABLE_BANKING_APP_ID', 'own-app-id')
    const supabase = makeSupabase({
      companies: { data: [{ id: COMPANY, team_id: null }] },
      company_capability_config: { data: [] },
      capability_grants: { data: [] },
    })
    expect(await getCompanyIdsWithCapability(supabase, [COMPANY], CAPABILITY.bank_sync)).toEqual(new Set([COMPANY]))
    expect(await getCompanyIdsWithCapability(supabase, [COMPANY], CAPABILITY.skatteverket)).toEqual(new Set())
  })

  it('getCompanyEntitlements counts own-credential keys as local paid and narrows the grants read', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    stubNoOwnCredentials()
    vi.stubEnv('ENABLE_BANKING_APP_ID', 'own-app-id')
    const calls: RecordedCall[] = []
    const result = await getCompanyEntitlements(
      makeRecordingSupabase(
        {
          companies: { data: { team_id: null } },
          capability_grants: { data: [] },
          company_capability_config: { data: [] },
          company_subscriptions: { data: null },
        },
        calls,
      ),
      COMPANY,
    )
    expect(result.capabilities).toContain(CAPABILITY.bank_sync)
    expect(result.capabilities).not.toContain(CAPABILITY.skatteverket)
    expect(result.entitlementState).toBe('none') // no connector grant; touchpoint renders nothing
    const grantKeyFilters = calls.filter(
      (c) => c.table === 'capability_grants' && c.method === 'in' && c.args[0] === 'capability_key',
    )
    expect(grantKeyFilters).toHaveLength(1)
    expect(grantKeyFilters[0].args[1]).toEqual([CAPABILITY.skatteverket])
  })

  it('getCompanyEntitlements skips the grants read entirely when every connector upstream has own credentials', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    stubNoOwnCredentials()
    vi.stubEnv('ENABLE_BANKING_APP_ID', 'own-app-id')
    vi.stubEnv('SKATTEVERKET_APIGW_CLIENT_ID', 'own-client')
    const calls: RecordedCall[] = []
    const result = await getCompanyEntitlements(
      makeRecordingSupabase(
        {
          companies: { data: { team_id: null } },
          company_capability_config: { data: [] },
          company_subscriptions: { data: null },
        },
        calls,
      ),
      COMPANY,
      { teamId: null },
    )
    expect(result.capabilities).toEqual([...PAID_CAPABILITIES])
    expect(calls.filter((c) => c.table === 'capability_grants')).toHaveLength(0)
  })

  it('self-host block copy names the connector key, hosted copy keeps the subscription upsell', async () => {
    stubNoOwnCredentials()
    const hosted = await capabilityBlockedResponse(CAPABILITY.bank_sync).json()
    expect(hosted.error).toContain('prenumeration')
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    const selfHost = await capabilityBlockedResponse(CAPABILITY.bank_sync).json()
    expect(selfHost.error).toContain('GNUBOK_CONNECTOR_KEY')
    expect(selfHost.error_en).toContain('GNUBOK_CONNECTOR_KEY')
  })
})
