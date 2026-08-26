import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Covers the session health probe added to the daily bank sync.
 *
 * Before it, a connection only ever left 'active' by failing a transaction
 * fetch, so a session killed bank-side (several ASPSPs drop the previous AIS
 * session when the same PSU authorizes again) kept rendering as healthy with a
 * stale last_synced_at. Connections the sync loop skips (capability gate, every
 * account deselected) and connections parked in 'pending_selection' were never
 * checked at all.
 */

interface ClientState {
  active: Record<string, unknown>[]
  probeCandidates: Record<string, unknown>[]
  /**
   * Rows touched by an update. Always a list: the probe marks every connection
   * sharing one dead session in a single .in('id', [...]) write.
   */
  updates: { ids: unknown[]; payload: Record<string, unknown> }[]
}

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  probeSessionHealth: vi.fn(),
  syncAccountTransactions: vi.fn(),
  getCompanyIdsWithCapability: vi.fn(),
  runReconciliation: vi.fn(),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: mocks.createClient,
}))

vi.mock('@/lib/auth/cron', () => ({
  verifyCronSecret: vi.fn(() => null),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/extensions/general/enable-banking/lib/sync', () => ({
  syncAccountTransactions: (...args: unknown[]) => mocks.syncAccountTransactions(...args),
}))

vi.mock('@/lib/entitlements/has-capability', () => ({
  getCompanyIdsWithCapability: (...args: unknown[]) => mocks.getCompanyIdsWithCapability(...args),
}))

vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  runReconciliation: (...args: unknown[]) => mocks.runReconciliation(...args),
  DEFAULT_UNATTENDED_CONFIDENCE_THRESHOLD: 0.9,
}))

vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({ isConfigured: () => false, sendEmail: vi.fn() }),
}))

vi.mock('@/lib/branding/service', () => ({
  getBranding: () => ({ appName: 'Accounted' }),
}))

// Partial mock: the route also imports the real message constants and the
// consent-expiry helpers, and only the probe needs stubbing.
vi.mock('@/extensions/general/enable-banking/lib/api-client', async () => {
  const actual = await vi.importActual<
    typeof import('@/extensions/general/enable-banking/lib/api-client')
  >('@/extensions/general/enable-banking/lib/api-client')
  return {
    ...actual,
    probeSessionHealth: (...args: unknown[]) => mocks.probeSessionHealth(...args),
  }
})

import { REAUTH_REQUIRED_MESSAGE } from '@/extensions/general/enable-banking/lib/api-client'
import { GET } from '../route'

function makeClient(state: ClientState) {
  return {
    from: () => {
      const filters: Record<string, unknown> = {}
      let isDelete = false
      let updatePayload: Record<string, unknown> | null = null

      function result() {
        if (isDelete) return { data: [], error: null }
        if (updatePayload) {
          state.updates.push({
            ids: filters['in:id'] ? (filters['in:id'] as unknown[]) : [filters.id],
            payload: updatePayload,
          })
          return { data: null, error: null }
        }
        // The sync loop asks for status = 'active'; the probe pass asks for
        // status IN ('active','pending_selection').
        if (filters['in:status']) return { data: state.probeCandidates, error: null }
        if (filters.status === 'active') return { data: state.active, error: null }
        return { data: null, error: null }
      }

      const chain: Record<string, unknown> = {}
      const passthrough = ['select', 'not', 'lt', 'gte', 'order', 'limit', 'range']
      for (const method of passthrough) chain[method] = vi.fn(() => chain)
      chain.eq = vi.fn((col: string, value: unknown) => {
        filters[col] = value
        return chain
      })
      chain.in = vi.fn((col: string, values: unknown) => {
        filters[`in:${col}`] = values
        return chain
      })
      chain.delete = vi.fn(() => {
        isDelete = true
        return chain
      })
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        updatePayload = payload
        return chain
      })
      chain.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }))
      chain.then = (onFulfilled: (value: unknown) => unknown) =>
        Promise.resolve(result()).then(onFulfilled)
      return chain
    },
    auth: { admin: { getUserById: vi.fn().mockResolvedValue({ data: { user: null } }) } },
  }
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    company_id: 'company-1',
    user_id: 'user-1',
    bank_name: 'TestBank',
    session_id: 'sess-1',
    status: 'active',
    consent_expires: '2099-01-01T00:00:00Z',
    accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: true }],
    initial_sync_completed_at: '2026-01-01T00:00:00Z',
    last_expiry_notification_at: null,
    error_message: null,
    ...overrides,
  }
}

let state: ClientState

const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const originalServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
  state = { active: [], probeCandidates: [], updates: [] }
  mocks.createClient.mockImplementation(() => makeClient(state))
  mocks.getCompanyIdsWithCapability.mockImplementation(
    async (_supabase: unknown, companyIds: string[]) => new Set(companyIds),
  )
  mocks.syncAccountTransactions.mockResolvedValue({ imported: 0, duplicates: 0, errors: 0 })
  mocks.probeSessionHealth.mockResolvedValue('unknown')
})

afterEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl
  process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceKey
})

function cronRequest(): Request {
  return new Request('http://localhost:3000/api/extensions/enable-banking/sync/cron')
}

describe('GET /api/extensions/enable-banking/sync/cron: session health probe', () => {
  it('expires a connection whose session the bank has killed', async () => {
    state.probeCandidates = [connection()]
    mocks.probeSessionHealth.mockResolvedValue('dead')

    const response = await GET(cronRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ probedDead: 1 })
    expect(state.updates).toEqual([
      {
        ids: ['conn-1'],
        payload: { status: 'expired', error_message: REAUTH_REQUIRED_MESSAGE },
      },
    ])
  })

  it('expires every company sharing one dead session, on a single probe', async () => {
    // Cross-company session reuse means one consent can back several
    // companies. Probing per row would spend N identical API calls on one
    // session and expire the companies one nightly run at a time, so the
    // others would keep rendering as healthy in the meantime.
    state.probeCandidates = [
      connection({ id: 'conn-1', company_id: 'company-1' }),
      connection({ id: 'conn-2', company_id: 'company-2' }),
    ]
    mocks.probeSessionHealth.mockResolvedValue('dead')

    const response = await GET(cronRequest())

    expect(mocks.probeSessionHealth).toHaveBeenCalledTimes(1)
    await expect(response.json()).resolves.toMatchObject({ probedDead: 2 })
    expect(state.updates).toEqual([
      {
        ids: ['conn-1', 'conn-2'],
        payload: { status: 'expired', error_message: REAUTH_REQUIRED_MESSAGE },
      },
    ])
  })

  it('probes a connection parked in pending_selection, which the sync loop never touches', async () => {
    state.probeCandidates = [connection({ status: 'pending_selection', last_synced_at: null })]
    mocks.probeSessionHealth.mockResolvedValue('dead')

    await GET(cronRequest())

    expect(mocks.probeSessionHealth).toHaveBeenCalledWith('sess-1')
    expect(state.updates[0].payload).toMatchObject({ status: 'expired' })
  })

  it('leaves the connection alone when the probe is inconclusive', async () => {
    // Flipping a live connection to expired costs the user a full BankID
    // re-authorization, so only a definite 'dead' may act.
    state.probeCandidates = [connection()]
    mocks.probeSessionHealth.mockResolvedValue('unknown')

    await GET(cronRequest())

    expect(state.updates).toHaveLength(0)
  })

  it('leaves the connection alone when the session is alive', async () => {
    state.probeCandidates = [connection()]
    mocks.probeSessionHealth.mockResolvedValue('alive')

    await GET(cronRequest())

    expect(state.updates).toHaveLength(0)
  })

  it('does not probe a connection the sync loop just proved alive', async () => {
    // A successful transaction fetch is stronger evidence than the probe, and
    // the extra call would burn the ASPSP's per-consent request budget.
    state.active = [connection()]
    state.probeCandidates = [connection()]

    await GET(cronRequest())

    expect(mocks.syncAccountTransactions).toHaveBeenCalledTimes(1)
    expect(mocks.probeSessionHealth).not.toHaveBeenCalled()
  })

  it('probes a connection the capability gate skipped instead of leaving it "Aktiv"', async () => {
    // The silent skip that let a dead connection sit at 'active' for days.
    state.active = [connection()]
    state.probeCandidates = [connection()]
    mocks.getCompanyIdsWithCapability.mockResolvedValue(new Set())
    mocks.probeSessionHealth.mockResolvedValue('dead')

    await GET(cronRequest())

    expect(mocks.syncAccountTransactions).not.toHaveBeenCalled()
    expect(mocks.probeSessionHealth).toHaveBeenCalledWith('sess-1')
    expect(state.updates[0].payload).toMatchObject({ status: 'expired' })
  })

  it('selects an entitled connection after fifty ineligible queue rows', async () => {
    state.active = [
      ...Array.from({ length: 50 }, (_, index) => connection({
        id: `free-${index}`,
        company_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      })),
      connection({ id: 'paid-connection', company_id: '11111111-1111-4111-8111-111111111111' }),
    ]
    mocks.getCompanyIdsWithCapability.mockResolvedValue(
      new Set(['11111111-1111-4111-8111-111111111111']),
    )

    const response = await GET(cronRequest())

    expect(response.status).toBe(200)
    expect(mocks.syncAccountTransactions).toHaveBeenCalledTimes(1)
    expect(mocks.syncAccountTransactions.mock.calls[0][3]).toBe('paid-connection')
    await expect(response.json()).resolves.toMatchObject({ processed: 1 })
  })

  it('applies the fifty-connection cap after entitlement filtering', async () => {
    state.active = Array.from({ length: 51 }, (_, index) => connection({
      id: `paid-${index}`,
      company_id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    }))

    await GET(cronRequest())

    expect(mocks.syncAccountTransactions).toHaveBeenCalledTimes(50)
  })

  it('probes a connection whose accounts are all deselected', async () => {
    // This branch reports 'synced' without writing last_synced_at, so the row
    // looks fresh forever.
    state.active = [connection({ accounts_data: [{ uid: 'acc-1', currency: 'SEK', enabled: false }] })]
    state.probeCandidates = [connection()]
    mocks.probeSessionHealth.mockResolvedValue('dead')

    await GET(cronRequest())

    expect(mocks.syncAccountTransactions).not.toHaveBeenCalled()
    expect(state.updates[0].payload).toMatchObject({ status: 'expired' })
  })

  it('runs the probe even when there is nothing to sync', async () => {
    state.active = []
    state.probeCandidates = [connection({ status: 'pending_selection' })]
    mocks.probeSessionHealth.mockResolvedValue('dead')

    const response = await GET(cronRequest())

    await expect(response.json()).resolves.toMatchObject({ processed: 0, probedDead: 1 })
  })
})
