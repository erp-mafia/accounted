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
  // getCompanyEntitlements reads its grant rows through this RPC.
  const rpc = (fn: string) => {
    const result = fn === 'company_capability_grant_rows' ? byTable.capability_grants : undefined
    return Promise.resolve({ data: result?.data ?? null, error: result?.error ?? null })
  }
  return { from: (t: string) => chainFor(t), rpc }
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

// The first charge date asks Stripe whether a trialing subscription is still
// due to be charged: a trial cancelled in the portal stays 'trialing' in our
// row until it lapses without a charge.
const subscriptionsRetrieve = vi.fn()
vi.mock('@/lib/stripe/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/stripe/client')>()),
  getStripe: () => ({ subscriptions: { retrieve: subscriptionsRetrieve } }),
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

// Subscribing during the product trial defers the first charge to the trial
// end: Stripe keeps the subscription 'trialing' with current_period_end on
// that date. The paying card shows it, since the entitlement read stops
// reporting trialEndsAt once the stripe grant exists.
describe('GET /api/billing/status first charge date', () => {
  type FirstChargeBody = StatusBody & { firstChargeAt?: string }
  const STRIPE_LIVE = [{ capability_key: 'ai', expires_at: '2099-01-04T00:00:00Z', source: 'stripe', team_id: null }]
  const TRIALING_ROW = {
    status: 'trialing',
    plan: 'monthly',
    current_period_end: '2099-01-01T09:00:00+00:00',
    stripe_subscription_id: 'sub_test_1',
  }

  beforeEach(() => {
    subscriptionsRetrieve.mockResolvedValue({ status: 'trialing', cancel_at_period_end: false, cancel_at: null })
  })

  it('returns the deferred first charge date for a trialing subscription', async () => {
    authAs({
      company_subscriptions: { data: TRIALING_ROW },
      capability_grants: { data: [...TRIAL_LIVE, ...STRIPE_LIVE] },
    })

    const { status, body } = await parseJsonResponse<FirstChargeBody>(await GET())

    expect(status).toBe(200)
    expect(body.isPaying).toBe(true)
    expect(body.trialEndsAt).toBeNull()
    expect(body.firstChargeAt).toBe('2099-01-01T09:00:00+00:00')
    expect(subscriptionsRetrieve).toHaveBeenCalledWith('sub_test_1')
  })

  it.each([
    ['cancel_at_period_end', { status: 'trialing', cancel_at_period_end: true, cancel_at: 4070941200 }],
    ['cancel_at', { status: 'trialing', cancel_at_period_end: false, cancel_at: 4070941200 }],
  ])('omits it for a trial cancelled in the portal (%s set)', async (_field, live) => {
    subscriptionsRetrieve.mockResolvedValue(live)
    authAs({
      company_subscriptions: { data: TRIALING_ROW },
      capability_grants: { data: STRIPE_LIVE },
    })

    const { body } = await parseJsonResponse<FirstChargeBody>(await GET())

    expect(body.isPaying).toBe(true)
    expect('firstChargeAt' in (body as object)).toBe(false)
  })

  it('omits it when Stripe cannot be asked (fails closed)', async () => {
    subscriptionsRetrieve.mockRejectedValue(new Error('stripe unavailable'))
    authAs({
      company_subscriptions: { data: TRIALING_ROW },
      capability_grants: { data: STRIPE_LIVE },
    })

    const { status, body } = await parseJsonResponse<FirstChargeBody>(await GET())

    expect(status).toBe(200)
    expect(body.isPaying).toBe(true)
    expect('firstChargeAt' in (body as object)).toBe(false)
  })

  it('never asks Stripe for a demo account', async () => {
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1', is_anonymous: true },
      supabase: makeSupabase({
        company_subscriptions: { data: TRIALING_ROW },
        capability_grants: { data: STRIPE_LIVE },
      }),
      error: null,
    })

    const { body } = await parseJsonResponse<FirstChargeBody>(await GET())

    expect('firstChargeAt' in (body as object)).toBe(false)
    expect(subscriptionsRetrieve).not.toHaveBeenCalled()
  })

  it('omits it for an active subscription (the first charge is behind)', async () => {
    authAs({
      company_subscriptions: {
        data: { status: 'active', plan: 'monthly', current_period_end: '2099-01-01T09:00:00+00:00' },
      },
      capability_grants: { data: STRIPE_LIVE },
    })

    const { body } = await parseJsonResponse<FirstChargeBody>(await GET())

    expect(body.isPaying).toBe(true)
    expect('firstChargeAt' in (body as object)).toBe(false)
    expect(subscriptionsRetrieve).not.toHaveBeenCalled()
  })

  it('omits it for a trialing subscription whose period end has passed', async () => {
    authAs({
      company_subscriptions: {
        data: { ...TRIALING_ROW, current_period_end: '2020-01-01T09:00:00+00:00' },
      },
      capability_grants: { data: STRIPE_LIVE },
    })

    const { body } = await parseJsonResponse<FirstChargeBody>(await GET())

    expect(body.isPaying).toBe(true)
    expect('firstChargeAt' in (body as object)).toBe(false)
    expect(subscriptionsRetrieve).not.toHaveBeenCalled()
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

describe('GET /api/billing/status subscription interval', () => {
  it('returns the paying company\'s interval so the plan card shows its price', async () => {
    authAs({
      company_subscriptions: { data: { status: 'active', plan: 'monthly' } },
      capability_grants: { data: null },
    })

    const { body } = await parseJsonResponse<StatusBody & { subscriptionPlan?: string }>(await GET())
    expect(body.isPaying).toBe(true)
    expect(body.subscriptionPlan).toBe('monthly')
  })

  it('omits the interval for a company that is not paying', async () => {
    authAs({
      company_subscriptions: { data: null },
      capability_grants: { data: TRIAL_LIVE },
    })
    serviceByTable = { companies: { data: { team_id: null } } }

    const { body } = await parseJsonResponse<StatusBody & { subscriptionPlan?: string }>(await GET())
    expect('subscriptionPlan' in (body as object)).toBe(false)
  })
})
