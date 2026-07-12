/**
 * Tests for GET /api/billing/status.
 *
 * Focus: the isPaying classification. 'trialing' must count as paying since
 * checkout defers the first charge to the trial end (the card is committed),
 * while a company with no subscription stays on the upgrade path.
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
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/sandbox/guard', () => ({
  isSandboxCompany: vi.fn().mockResolvedValue(false),
}))

import { GET } from '../status/route'

interface StatusBody {
  isPaying: boolean
  trialEndsAt: string | null
  isDemo: boolean
}

function authAs(byTable: Record<string, TableResult>) {
  requireAuthMock.mockResolvedValue({
    user: { id: 'user-1', is_anonymous: false },
    supabase: makeSupabase(byTable),
    error: null,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/billing/status', () => {
  it('treats a trialing subscription as paying (card committed via deferred checkout)', async () => {
    authAs({
      company_subscriptions: { data: { status: 'trialing' } },
      capability_grants: { data: { expires_at: '2099-01-01T00:00:00Z' } },
    })

    const { status, body } = await parseJsonResponse<StatusBody>(await GET())

    expect(status).toBe(200)
    expect(body.isPaying).toBe(true)
  })

  it('keeps a card-less product trial on the upgrade path with its expiry', async () => {
    authAs({
      company_subscriptions: { data: null },
      capability_grants: { data: { expires_at: '2099-01-01T00:00:00Z' } },
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
