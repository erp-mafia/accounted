import { describe, it, expect, afterEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  hasCapability,
  requireCapability,
  capabilityBlockedResponse,
  getCompanyEntitlements,
} from '../has-capability'
import { CAPABILITY, PAID_CAPABILITIES } from '../keys'

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

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

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
  })

  it('returns no trial and no capabilities after the trial lapsed', async () => {
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: {
        data: [{ capability_key: CAPABILITY.ai, expires_at: iso(-60_000), source: 'trial' }],
      },
    })
    const result = await getCompanyEntitlements(supabase, companyId)
    expect(result.trialEndsAt).toBeNull()
    expect(result.capabilities).toEqual([])
  })

  it('bypass (self-hosted) holds everything with no trial countdown', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    const supabase = makeSupabase({})
    const result = await getCompanyEntitlements(supabase, companyId)
    expect(result.trialEndsAt).toBeNull()
    expect(result.capabilities).toEqual([...PAID_CAPABILITIES])
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
