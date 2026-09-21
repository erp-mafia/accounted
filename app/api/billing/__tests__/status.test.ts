/**
 * Tests for GET /api/billing/status.
 *
 * Focus: the isPaying classification. 'trialing' must count as paying since
 * checkout defers the first charge to the trial end (the card is committed),
 * while a company with no subscription stays on the upgrade path.
 *
 * The route relays getCompanyEntitlements (the one definition of "paid"), so
 * these run the real resolver over mocked rows rather than mocking it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse } from '@/tests/helpers'

type TableResult = { data: unknown; error?: unknown }
function makeSupabase(byTable: Record<string, TableResult>) {
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
  return { from: (t: string) => chainFor(t) }
}

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111'),
}))

vi.mock('@/lib/sandbox/guard', () => ({
  isSandboxCompany: vi.fn().mockResolvedValue(false),
}))

// Service client for the WL-10 team-agreement lookup (end clients cannot read
// the byrå team or its grants under RLS, so the route uses the service role).
let serviceByTable: Record<string, TableResult> = {}
const createServiceClientMock = vi.fn(() => makeSupabase(serviceByTable))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => createServiceClientMock(),
  createClient: vi.fn(),
}))

import { GET } from '../status/route'

interface StatusBody {
  isPaying: boolean
  trialEndsAt: string | null
  isDemo: boolean
  teamAgreement?: { teamName: string }
  entitlementState: string
  coverage: { kind: string; coveredUntil: string | null } | null
}

const TRIAL_LIVE = [{ capability_key: 'ai', expires_at: '2099-01-01T00:00:00Z', source: 'trial', team_id: null }]
const TRIAL_LAPSED = [{ capability_key: 'ai', expires_at: '2020-01-01T00:00:00Z', source: 'trial', team_id: null }]

function authAs(byTable: Record<string, TableResult>) {
  requireAuthMock.mockResolvedValue({
    user: { id: 'user-1', is_anonymous: false },
    supabase: makeSupabase(byTable),
    error: null,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  serviceByTable = {}
})

describe('GET /api/billing/status', () => {
  it('treats a trialing subscription as paying (card committed via deferred checkout)', async () => {
    authAs({
      company_subscriptions: { data: { status: 'trialing' } },
      capability_grants: { data: TRIAL_LIVE },
    })

    const { status, body } = await parseJsonResponse<StatusBody>(await GET())

    expect(status).toBe(200)
    expect(body.isPaying).toBe(true)
  })

  it('keeps a card-less product trial on the upgrade path with its expiry', async () => {
    authAs({
      company_subscriptions: { data: null },
      capability_grants: { data: TRIAL_LIVE },
    })

    const { status, body } = await parseJsonResponse<StatusBody>(await GET())

    expect(status).toBe(200)
    expect(body.isPaying).toBe(false)
    expect(body.trialEndsAt).toBe('2099-01-01T00:00:00Z')
  })

  it('treats an active subscription as paying', async () => {
    authAs({
      company_subscriptions: { data: { status: 'active' } },
      capability_grants: { data: null },
    })

    const { body } = await parseJsonResponse<StatusBody>(await GET())
    expect(body.isPaying).toBe(true)
  })

  it('treats a canceled subscription as not paying', async () => {
    authAs({
      company_subscriptions: { data: { status: 'canceled' } },
      capability_grants: { data: null },
    })

    const { body } = await parseJsonResponse<StatusBody>(await GET())
    expect(body.isPaying).toBe(false)
  })
})

// WL-10 billing honesty: a non-paying company under a byrå team with an
// active team-scoped manual grant gets the additive teamAgreement field.
describe('GET /api/billing/status team agreement', () => {
  it('returns teamAgreement for a byrå-covered non-paying company', async () => {
    authAs({
      company_subscriptions: { data: null },
      capability_grants: { data: TRIAL_LAPSED },
    })
    serviceByTable = {
      companies: { data: { team_id: 'team-1' } },
      teams: { data: { name: 'Siffran AB', kind: 'byra' } },
      capability_grants: { data: [{ expires_at: null }] },
    }

    const { status, body } = await parseJsonResponse<StatusBody>(await GET())
    expect(status).toBe(200)
    expect(body.isPaying).toBe(false)
    expect(body.teamAgreement).toEqual({ teamName: 'Siffran AB' })
  })

  it('accepts a future-dated grant expiry', async () => {
    authAs({
      company_subscriptions: { data: null },
      capability_grants: { data: TRIAL_LAPSED },
    })
    serviceByTable = {
      companies: { data: { team_id: 'team-1' } },
      teams: { data: { name: 'Siffran AB', kind: 'byra' } },
      capability_grants: { data: [{ expires_at: '2099-01-01T00:00:00Z' }] },
    }

    const { body } = await parseJsonResponse<StatusBody>(await GET())
    expect(body.teamAgreement).toEqual({ teamName: 'Siffran AB' })
  })

  it('ignores an expired team grant (grace lapsed: standard paywall)', async () => {
    authAs({
      company_subscriptions: { data: null },
      capability_grants: { data: TRIAL_LAPSED },
    })
    serviceByTable = {
      companies: { data: { team_id: 'team-1' } },
      teams: { data: { name: 'Siffran AB', kind: 'byra' } },
      capability_grants: { data: [{ expires_at: '2020-01-01T00:00:00Z' }] },
    }

    const { body } = await parseJsonResponse<StatusBody>(await GET())
    expect(body.isPaying).toBe(false)
    expect(body.teamAgreement).toBeUndefined()
  })

  it('ignores a personal team even with a manual grant', async () => {
    authAs({
      company_subscriptions: { data: null },
      capability_grants: { data: TRIAL_LAPSED },
    })
    serviceByTable = {
      companies: { data: { team_id: 'team-1' } },
      teams: { data: { name: 'Personal', kind: 'personal' } },
      capability_grants: { data: [{ expires_at: null }] },
    }

    const { body } = await parseJsonResponse<StatusBody>(await GET())
    expect(body.teamAgreement).toBeUndefined()
  })

  it('leaves a teamless company unchanged', async () => {
    authAs({
      company_subscriptions: { data: null },
      capability_grants: { data: TRIAL_LIVE },
    })
    serviceByTable = {
      companies: { data: { team_id: null } },
    }

    const { body } = await parseJsonResponse<StatusBody>(await GET())
    expect(body.isPaying).toBe(false)
    expect(body.trialEndsAt).toBe('2099-01-01T00:00:00Z')
    expect(body.teamAgreement).toBeUndefined()
    expect('teamAgreement' in (body as object)).toBe(false)
  })

  it('never consults the team path for a paying company', async () => {
    authAs({
      company_subscriptions: { data: { status: 'active' } },
      capability_grants: { data: null },
    })

    const { body } = await parseJsonResponse<StatusBody>(await GET())
    expect(body.isPaying).toBe(true)
    expect(body.teamAgreement).toBeUndefined()
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })
})

// One definition of "paid": a company covered by a manual or comp grant has
// paid, so it must never be handed the sell view.
describe('GET /api/billing/status agreement coverage', () => {
  it('returns 401 without a session', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: null,
      error: new Response(JSON.stringify({ error: { code: 'unauthorized' } }), { status: 401 }),
    })
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('reports agreement coverage with its end date for a manual grant', async () => {
    authAs({
      company_subscriptions: { data: null },
      capability_grants: {
        data: [
          ...TRIAL_LAPSED,
          { capability_key: 'ai', expires_at: '2099-07-10T00:00:00Z', source: 'manual', team_id: null },
        ],
      },
    })
    serviceByTable = { companies: { data: { team_id: null } } }

    const { status, body } = await parseJsonResponse<StatusBody>(await GET())
    expect(status).toBe(200)
    expect(body.isPaying).toBe(false)
    expect(body.entitlementState).toBe('paid')
    expect(body.coverage).toEqual({ kind: 'agreement', coveredUntil: '2099-07-10T00:00:00Z' })
  })

  it('reports an open-ended comp grant without a date', async () => {
    authAs({
      company_subscriptions: { data: null },
      capability_grants: {
        data: [{ capability_key: 'ai', expires_at: null, source: 'comp', team_id: null }],
      },
    })

    const { body } = await parseJsonResponse<StatusBody>(await GET())
    expect(body.coverage).toEqual({ kind: 'agreement', coveredUntil: null })
  })

  it('keeps an expired manual grant on the sell view with the lapsed trial date', async () => {
    authAs({
      company_subscriptions: { data: null },
      capability_grants: {
        data: [
          ...TRIAL_LAPSED,
          { capability_key: 'ai', expires_at: '2021-01-01T00:00:00Z', source: 'manual', team_id: null },
        ],
      },
    })

    const { body } = await parseJsonResponse<StatusBody>(await GET())
    expect(body.isPaying).toBe(false)
    expect(body.coverage).toBeNull()
    expect(body.entitlementState).toBe('trial_expired')
    expect(body.trialEndsAt).toBe('2020-01-01T00:00:00Z')
  })

  it('keeps a lone comp multi_user grant on the sell view', async () => {
    authAs({
      company_subscriptions: { data: null },
      capability_grants: {
        data: [
          ...TRIAL_LAPSED,
          { capability_key: 'multi_user', expires_at: null, source: 'comp', team_id: null },
        ],
      },
    })

    const { body } = await parseJsonResponse<StatusBody>(await GET())
    expect(body.coverage).toBeNull()
    expect(body.entitlementState).toBe('trial_expired')
  })

  it('a Stripe subscription stays subscription coverage even with a manual grant', async () => {
    authAs({
      company_subscriptions: { data: { status: 'active' } },
      capability_grants: {
        data: [
          { capability_key: 'ai', expires_at: '2099-01-01T00:00:00Z', source: 'stripe', team_id: null },
          { capability_key: 'ai', expires_at: null, source: 'manual', team_id: null },
        ],
      },
    })

    const { body } = await parseJsonResponse<StatusBody>(await GET())
    expect(body.isPaying).toBe(true)
    expect(body.coverage).toEqual({ kind: 'subscription', coveredUntil: null })
  })
})
