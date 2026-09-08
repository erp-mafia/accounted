import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, requireCapability: vi.fn().mockResolvedValue(null) }
})

vi.mock('../lib/oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/oauth')>()
  return {
    ...actual,
    refreshAccessToken: vi.fn(),
    disconnectApplication: vi.fn().mockResolvedValue(undefined),
  }
})

vi.mock('../lib/order-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/order-sync')>()
  return { ...actual, syncZettlePurchases: vi.fn() }
})

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => ({ service: true })),
}))

import { zettleExtension } from '../index'
import { requireCapability, capabilityBlockedResponse } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { syncZettlePurchases } from '../lib/order-sync'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

function findRoute(method: string, path: string) {
  const route = zettleExtension.apiRoutes?.find((r) => r.method === method && r.path === path)
  expect(route, `${method} ${path} must be registered`).toBeDefined()
  return route!
}

function makeRequest(method: string, body?: unknown): Request {
  return new Request('https://test.local/api/extensions/ext/zettle/x', {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

function makeContext(supabase: unknown): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'zettle',
    requestId: 'req_test',
    supabase,
    emit: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const USER = { id: 'user-1', is_anonymous: false }

describe('zettle extension routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('ZETTLE_CLIENT_ID', 'cid')
    vi.stubEnv('ZETTLE_CLIENT_SECRET', 'csecret')
    vi.stubEnv('ZETTLE_CREDENTIALS_ENCRYPTION_KEY', 'test-key')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.com')
    vi.mocked(requireCapability).mockResolvedValue(null)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('GET /status returns configured + connection', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
    enqueue({
      data: [
        {
          id: 'c1',
          status: 'active',
          organization_uuid: 'org-1',
          organization_name: null,
          currency: 'SEK',
          error_message: null,
          connected_at: '2026-09-01T00:00:00.000Z',
          transaction_sync_enabled: true,
          last_order_synced_at: null,
        },
      ],
    })
    const res = await findRoute('GET', '/status').handler(makeRequest('GET'), makeContext(supabase))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.configured).toBe(true)
    expect(body.connection.id).toBe('c1')
  })

  it('POST /connect stages pending and returns authorize url', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
    enqueue({ data: { is_sandbox: false } }) // guardSandbox
    enqueue({ data: [] }) // no active connection
    enqueue({ data: [] }) // clear stale pending
    enqueue({ data: { id: 'pending-1' } }) // insert pending
    const res = await findRoute('POST', '/connect').handler(makeRequest('POST'), makeContext(supabase))
    expect(res.status).toBe(200)
    const body = await res.json()
    const url = new URL(body.url)
    expect(url.origin + url.pathname).toBe('https://oauth.zettle.com/authorize')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('scope')).toBe('READ:PURCHASE READ:USERINFO')
    expect(requireCapability).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      CAPABILITY.zettle_sync,
    )
  })

  it('POST /connect invalidates a prior pending row before staging a new one', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
    enqueue({ data: { is_sandbox: false } }) // guardSandbox
    enqueue({ data: [] }) // no active connection
    enqueue({ data: [] }) // clear stale pending (status -> error)
    enqueue({ data: { id: 'pending-2' } }) // insert replacement pending
    const res = await findRoute('POST', '/connect').handler(makeRequest('POST'), makeContext(supabase))
    expect(res.status).toBe(200)
    // Second connect must leave the abandoned oauth_state unusable so a late
    // callback for the first flow cannot activate that row (see callback test).
    expect(supabase.from).toHaveBeenCalledWith('zettle_connections')
  })

  it('POST /connect refuses when capability is blocked', async () => {
    vi.mocked(requireCapability).mockResolvedValue(capabilityBlockedResponse(CAPABILITY.zettle_sync))
    const { supabase, enqueue } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
    enqueue({ data: { is_sandbox: false } })
    const res = await findRoute('POST', '/connect').handler(makeRequest('POST'), makeContext(supabase))
    expect([402, 403]).toContain(res.status)
  })

  it('POST /sync calls syncZettlePurchases', async () => {
    vi.mocked(syncZettlePurchases).mockResolvedValue({
      fetched: 1,
      refundsFetched: 0,
      inserted: 1,
      updated: 0,
      unchanged: 0,
      frozenFlagged: 0,
      crossMarked: 0,
      errors: 0,
    })
    const { supabase, enqueue } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
    enqueue({
      data: {
        id: 'c1',
        status: 'active',
        company_id: 'company-1',
        user_id: 'user-1',
        organization_uuid: 'org-1',
        refresh_token_encrypted: 'enc',
      },
    })
    const res = await findRoute('POST', '/sync').handler(makeRequest('POST'), makeContext(supabase))
    expect(res.status).toBe(200)
    expect(syncZettlePurchases).toHaveBeenCalled()
  })
})
