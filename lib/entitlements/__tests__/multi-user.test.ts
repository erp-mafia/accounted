import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  computeMultiUserState,
  isMembershipDormant,
  MULTI_USER_GRACE_DAYS,
} from '../multi-user-state'
import { getMultiUserState, isMembershipActive, isMultiUserEnforced } from '../multi-user'

const DAY_MS = 86_400_000
const COMPANY = '11111111-1111-4111-8111-111111111111'

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

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

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('computeMultiUserState', () => {
  const now = Date.now()

  it('is entitled on a never-expiring grant', () => {
    expect(computeMultiUserState([{ expires_at: null }], now).state).toBe('entitled')
  })

  it('is entitled on an unexpired grant even when an older one lapsed', () => {
    const access = computeMultiUserState(
      [{ expires_at: iso(-40 * DAY_MS) }, { expires_at: iso(60_000) }],
      now,
    )
    expect(access.state).toBe('entitled')
    expect(access.graceEndsAt).toBeNull()
  })

  it('is in grace right after expiry, with graceEndsAt = expiry + 20 days', () => {
    const expiry = iso(-60_000)
    const access = computeMultiUserState([{ expires_at: expiry }], now)
    expect(access.state).toBe('grace')
    expect(new Date(access.graceEndsAt!).getTime()).toBe(
      new Date(expiry).getTime() + MULTI_USER_GRACE_DAYS * DAY_MS,
    )
  })

  it('is still in grace on day 19 after the lapse', () => {
    const access = computeMultiUserState([{ expires_at: iso(-19 * DAY_MS) }], now)
    expect(access.state).toBe('grace')
  })

  it('is frozen once the lapse is 20 full days old', () => {
    // Derive the expiry from the SAME clock the check uses: iso() reads
    // Date.now() at call time, which sits a few ms after `now` and would
    // land the boundary case back inside the grace window.
    const expiry = new Date(now - MULTI_USER_GRACE_DAYS * DAY_MS - 1000).toISOString()
    const access = computeMultiUserState([{ expires_at: expiry }], now)
    expect(access.state).toBe('frozen')
    expect(access.graceEndsAt).toBeNull()
  })

  it('the NEWEST expiry drives the grace window (a fresh manual grant extends it)', () => {
    // Grandfather shape: trial lapsed long ago, backfill grant expired "now".
    const access = computeMultiUserState(
      [{ expires_at: iso(-56 * DAY_MS) }, { expires_at: iso(-1000) }],
      now,
    )
    expect(access.state).toBe('grace')
  })

  it('is frozen when never granted', () => {
    expect(computeMultiUserState([], now).state).toBe('frozen')
  })
})

describe('isMembershipDormant', () => {
  it('owners are never dormant, frozen company or not', () => {
    expect(isMembershipDormant('owner', 'frozen')).toBe(false)
  })
  it('non-owners are dormant only in the frozen state', () => {
    expect(isMembershipDormant('admin', 'frozen')).toBe(true)
    expect(isMembershipDormant('member', 'frozen')).toBe(true)
    expect(isMembershipDormant('viewer', 'frozen')).toBe(true)
    expect(isMembershipDormant('member', 'grace')).toBe(false)
    expect(isMembershipDormant('member', 'entitled')).toBe(false)
  })
})

describe('getMultiUserState', () => {
  it('is entitled on self-hosted without touching the DB', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    const supabase = makeSupabase({}) // would be frozen if the gate ran
    expect((await getMultiUserState(supabase, COMPANY)).state).toBe('entitled')
  })

  it('is entitled under the dev bypass', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const supabase = makeSupabase({})
    expect((await getMultiUserState(supabase, COMPANY)).state).toBe('entitled')
  })

  it('FORCE_PAYWALL activates the real gate in development', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('FORCE_PAYWALL', 'true')
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: { data: [] },
    })
    expect((await getMultiUserState(supabase, COMPANY)).state).toBe('frozen')
  })

  it('is frozen for a non-UUID company id', async () => {
    const supabase = makeSupabase({})
    expect((await getMultiUserState(supabase, 'not-a-uuid')).state).toBe('frozen')
  })

  it('reads grants and derives grace from the newest expiry', async () => {
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: { data: [{ expires_at: iso(-DAY_MS) }] },
    })
    const access = await getMultiUserState(supabase, COMPANY)
    expect(access.state).toBe('grace')
    expect(access.graceEndsAt).not.toBeNull()
  })

  it('a known teamId skips the companies lookup and still resolves', async () => {
    const supabase = makeSupabase({
      // companies deliberately absent: querying it would resolve null and be harmless,
      // but the team grant below is what entitles.
      capability_grants: { data: [{ expires_at: null }] },
    })
    const access = await getMultiUserState(supabase, COMPANY, {
      teamId: '22222222-2222-4222-8222-222222222222',
    })
    expect(access.state).toBe('entitled')
  })

  it('fails OPEN (entitled) on a grants read error', async () => {
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: { data: null, error: { message: 'boom' } },
    })
    expect((await getMultiUserState(supabase, COMPANY)).state).toBe('entitled')
  })
})

describe('isMembershipActive', () => {
  it('owner passes without a grants read', async () => {
    const supabase = makeSupabase({}) // would be frozen if consulted
    expect(await isMembershipActive(supabase, COMPANY, 'owner')).toBe(true)
  })

  it('non-owner in a frozen company is inactive', async () => {
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: { data: [] },
    })
    expect(await isMembershipActive(supabase, COMPANY, 'member')).toBe(false)
  })

  it('non-owner in grace stays active', async () => {
    const supabase = makeSupabase({
      companies: { data: { team_id: null } },
      capability_grants: { data: [{ expires_at: iso(-DAY_MS) }] },
    })
    expect(await isMembershipActive(supabase, COMPANY, 'member')).toBe(true)
  })
})

describe('isMultiUserEnforced', () => {
  it('is enforced in the test environment (NODE_ENV=test, hosted)', () => {
    expect(isMultiUserEnforced()).toBe(true)
  })
  it('is not enforced on self-hosted', () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
    expect(isMultiUserEnforced()).toBe(false)
  })
})
