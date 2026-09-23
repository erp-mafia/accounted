import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Covers the daily session health probe. It used to be the tail of the bank
 * sync cron; it has its own schedule since that one went hourly.
 *
 * Before the probe, a connection only ever left 'active' by failing a
 * transaction fetch, so a session killed bank-side (several ASPSPs drop the
 * previous AIS session when the same PSU authorizes again) kept rendering as
 * healthy with a stale last_synced_at. Connections the sync cron skips
 * (capability gate, every account deselected) and connections parked in
 * 'pending_selection' were never checked at all.
 */

interface ClientState {
  candidates: Record<string, unknown>[]
  updates: { ids: unknown[]; payload: Record<string, unknown> }[]
}

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  probeSessionHealth: vi.fn(),
  registryGet: vi.fn(),
}))

vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }))
vi.mock('@/lib/auth/cron', () => ({ verifyCronSecret: vi.fn(() => null) }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/extensions/registry', () => ({
  extensionRegistry: { get: (...args: unknown[]) => mocks.registryGet(...args) },
}))
vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({ isConfigured: () => false, sendEmail: vi.fn() }),
}))
vi.mock('@/lib/branding/service', () => ({ getBranding: () => ({ appName: 'Accounted' }) }))
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
      let inIds: unknown[] | null = null
      let updatePayload: Record<string, unknown> | null = null
      const chain: Record<string, unknown> = {}
      for (const method of ['select', 'not', 'order', 'limit']) chain[method] = vi.fn(() => chain)
      chain.in = vi.fn((col: string, values: unknown[]) => {
        if (col === 'id') inIds = values
        return chain
      })
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        updatePayload = payload
        return chain
      })
      chain.then = (onFulfilled: (value: unknown) => unknown) => {
        if (updatePayload) {
          state.updates.push({ ids: inIds ?? [], payload: updatePayload })
          return Promise.resolve({ data: null, error: null }).then(onFulfilled)
        }
        return Promise.resolve({ data: state.candidates, error: null }).then(onFulfilled)
      }
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
    last_synced_at: null,
    last_expiry_notification_at: null,
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
  state = { candidates: [], updates: [] }
  mocks.createClient.mockImplementation(() => makeClient(state))
  mocks.registryGet.mockReturnValue({ id: 'enable-banking' })
  mocks.probeSessionHealth.mockResolvedValue('unknown')
})

afterEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl
  process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceKey
})

function cronRequest(): Request {
  return new Request('http://localhost:3000/api/extensions/enable-banking/health-probe/cron')
}

describe('GET /api/extensions/enable-banking/health-probe/cron', () => {
  it('refuses to run when the extension is not enabled', async () => {
    mocks.registryGet.mockReturnValue(undefined)

    const response = await GET(cronRequest())

    expect(response.status).toBe(503)
    expect(mocks.probeSessionHealth).not.toHaveBeenCalled()
  })

  it('expires a connection whose session the bank has killed', async () => {
    state.candidates = [connection()]
    mocks.probeSessionHealth.mockResolvedValue('dead')

    const response = await GET(cronRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ probedDead: 1 })
    expect(state.updates).toEqual([
      { ids: ['conn-1'], payload: { status: 'expired', error_message: REAUTH_REQUIRED_MESSAGE } },
    ])
  })

  it('expires every company sharing one dead session, on a single probe', async () => {
    // Cross-company session reuse means one consent can back several
    // companies. Probing per row would spend N identical API calls on one
    // session and expire the companies one run at a time.
    state.candidates = [
      connection({ id: 'conn-1', company_id: 'company-1' }),
      connection({ id: 'conn-2', company_id: 'company-2' }),
    ]
    mocks.probeSessionHealth.mockResolvedValue('dead')

    const response = await GET(cronRequest())

    expect(mocks.probeSessionHealth).toHaveBeenCalledTimes(1)
    await expect(response.json()).resolves.toMatchObject({ probedDead: 2 })
    expect(state.updates).toEqual([
      { ids: ['conn-1', 'conn-2'], payload: { status: 'expired', error_message: REAUTH_REQUIRED_MESSAGE } },
    ])
  })

  it('probes a connection parked in pending_selection, which the sync cron never touches', async () => {
    state.candidates = [connection({ status: 'pending_selection' })]
    mocks.probeSessionHealth.mockResolvedValue('dead')

    await GET(cronRequest())

    expect(mocks.probeSessionHealth).toHaveBeenCalledWith('sess-1')
    expect(state.updates[0].payload).toMatchObject({ status: 'expired' })
  })

  it('leaves the connection alone when the probe is inconclusive', async () => {
    // Flipping a live connection to expired costs the user a full BankID
    // re-authorization, so only a definite 'dead' may act.
    state.candidates = [connection()]
    mocks.probeSessionHealth.mockResolvedValue('unknown')

    await GET(cronRequest())

    expect(state.updates).toHaveLength(0)
  })

  it('leaves the connection alone when the session is alive', async () => {
    state.candidates = [connection()]
    mocks.probeSessionHealth.mockResolvedValue('alive')

    await GET(cronRequest())

    expect(state.updates).toHaveLength(0)
  })

  it('does not probe a session a recent sync proved alive, through any of its companies', async () => {
    // A successful transaction fetch is stronger evidence than the probe, and
    // the extra call would burn the ASPSP's per-consent request budget.
    state.candidates = [
      connection({ id: 'never-synced', company_id: 'company-2' }),
      connection({ id: 'synced', last_synced_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }),
    ]

    await GET(cronRequest())

    expect(mocks.probeSessionHealth).not.toHaveBeenCalled()
  })

  it('probes a session whose last sync is more than a day old', async () => {
    state.candidates = [
      connection({ last_synced_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString() }),
    ]

    await GET(cronRequest())

    expect(mocks.probeSessionHealth).toHaveBeenCalledTimes(1)
  })

  it('keeps probing after one session fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    state.candidates = [
      connection({ id: 'conn-1', session_id: 'sess-1' }),
      connection({ id: 'conn-2', session_id: 'sess-2' }),
    ]
    mocks.probeSessionHealth.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce('dead')

    const response = await GET(cronRequest())

    await expect(response.json()).resolves.toMatchObject({ probed: 2, probedDead: 1 })
    consoleError.mockRestore()
  })
})
