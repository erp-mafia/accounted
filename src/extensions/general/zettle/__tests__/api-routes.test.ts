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

// Never reach Zettle from a unit test: the remote revoke is observed, not run.
vi.mock('../lib/oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/oauth')>()
  return {
    ...actual,
    refreshAccessToken: vi.fn(async () => ({ access_token: 'access-1' })),
    disconnectApplication: vi.fn(async () => undefined),
  }
})
vi.mock('../lib/credentials', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/credentials')>()
  return { ...actual, refreshTokenOf: vi.fn(() => 'plain-refresh') }
})

vi.mock('@/lib/auth/oauth-flows', () => ({
  resolveOAuthOrigin: vi.fn().mockResolvedValue('https://brand.testbrand.example'),
}))

import { zettleExtension } from '../index'
import { requireCapability, capabilityBlockedResponse } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { syncZettlePurchases } from '../lib/order-sync'
import { resolveOAuthOrigin } from '@/lib/auth/oauth-flows'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { disconnectApplication, refreshAccessToken } from '../lib/oauth'
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

/**
 * The next service client the route creates, answering `results` in order.
 * Sync, backfill and disconnect look the connection up there: the encrypted
 * refresh token is withheld from end-user roles (20260929173432).
 */
function serviceReturning(...results: Array<{ data?: unknown; error?: unknown }>) {
  const service = createQueuedMockSupabase()
  for (const result of results) service.enqueue(result)
  vi.mocked(createServiceClientNoCookies).mockReturnValueOnce(service.supabase as never)
  return service
}

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
    // The validated brand/app origin is frozen on the pending row so the
    // callback can send the browser back to the domain it started on.
    expect(resolveOAuthOrigin).toHaveBeenCalledTimes(1)
    expect(supabase.from).toHaveBeenCalledWith('zettle_connections')
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

  it('POST /backfill refuses without a session', async () => {
    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })
    const res = await findRoute('POST', '/backfill').handler(
      makeRequest('POST', { from: '2026-01-01' }),
      makeContext(supabase),
    )
    expect(res.status).toBe(401)
    expect(syncZettlePurchases).not.toHaveBeenCalled()
  })

  it('POST /backfill rejects a date it cannot honour', async () => {
    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
    const route = findRoute('POST', '/backfill')
    for (const from of [undefined, 'igar', '2026-02-31', '3000-01-01', '1990-01-01']) {
      const res = await route.handler(makeRequest('POST', { from }), makeContext(supabase))
      expect(res.status, `from=${String(from)}`).toBe(400)
    }
    expect(syncZettlePurchases).not.toHaveBeenCalled()
  })

  it('POST /backfill is 404 without an active connection', async () => {
    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
    serviceReturning({ data: null })
    const res = await findRoute('POST', '/backfill').handler(
      makeRequest('POST', { from: '2026-01-01' }),
      makeContext(supabase),
    )
    expect(res.status).toBe(404)
    expect(syncZettlePurchases).not.toHaveBeenCalled()
  })

  it('POST /backfill moves the cursor to the chosen date and syncs from there', async () => {
    vi.mocked(syncZettlePurchases).mockResolvedValue({
      fetched: 4,
      refundsFetched: 0,
      inserted: 4,
      updated: 0,
      unchanged: 0,
      frozenFlagged: 0,
      crossMarked: 0,
      errors: 0,
      needsReview: 0,
      skippedUnsupported: 0,
    })
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
    const service = serviceReturning({
      data: {
        id: 'c1',
        status: 'active',
        company_id: 'company-1',
        user_id: 'user-1',
        organization_uuid: 'org-1',
        refresh_token_encrypted: 'enc',
        last_order_synced_at: '2026-09-14T00:00:00.000Z',
      },
    })
    enqueue({ data: [] }) // cursor update (session client)
    const res = await findRoute('POST', '/backfill').handler(
      makeRequest('POST', { from: '2026-01-01' }),
      makeContext(supabase),
    )
    expect(res.status).toBe(200)
    expect(vi.mocked(syncZettlePurchases).mock.calls[0][0]).toBe(service.supabase)
    expect(service.findCall('zettle_connections', 'eq')).toEqual(['company_id', 'company-1'])
    expect(findCall('zettle_connections', 'select')).toBeUndefined()
    const body = await res.json()
    expect(body.from).toBe('2026-01-01T00:00:00.000Z')
    expect(body.transactions.inserted).toBe(4)
    const updates = findCalls('zettle_connections', 'update')
    expect(updates[0][0]).toMatchObject({ last_order_synced_at: '2026-01-01T00:00:00.000Z' })
    // The sync must see the moved cursor, not the stored one.
    const connectionArg = vi.mocked(syncZettlePurchases).mock.calls[0][1]
    expect(connectionArg.last_order_synced_at).toBe('2026-01-01T00:00:00.000Z')
  })

  it('POST /backfill restores the cursor when another run holds the claim', async () => {
    vi.mocked(syncZettlePurchases).mockResolvedValue({
      fetched: 0,
      refundsFetched: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      frozenFlagged: 0,
      crossMarked: 0,
      errors: 0,
      needsReview: 0,
      skippedUnsupported: 0,
      locked: true,
    })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
    serviceReturning({
      data: {
        id: 'c1',
        status: 'active',
        company_id: 'company-1',
        user_id: 'user-1',
        organization_uuid: 'org-1',
        refresh_token_encrypted: 'enc',
        last_order_synced_at: '2026-09-14T00:00:00.000Z',
      },
    })
    enqueue({ data: [] }) // cursor update (session client)
    enqueue({ data: [] }) // cursor restore (session client)
    const res = await findRoute('POST', '/backfill').handler(
      makeRequest('POST', { from: '2026-01-01' }),
      makeContext(supabase),
    )
    expect(res.status).toBe(409)
    const updates = findCalls('zettle_connections', 'update')
    expect(updates[1][0]).toEqual({ last_order_synced_at: '2026-09-14T00:00:00.000Z' })
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
      needsReview: 0,
      skippedUnsupported: 0,
    })
    const { supabase, findCall } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
    const service = serviceReturning({
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
    expect(vi.mocked(syncZettlePurchases).mock.calls[0][0]).toBe(service.supabase)
    expect(findCall('zettle_connections', 'select')).toBeUndefined()
  })

  it('POST /sync is 404 without an active connection', async () => {
    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
    serviceReturning({ data: null })
    const res = await findRoute('POST', '/sync').handler(makeRequest('POST'), makeContext(supabase))
    expect(res.status).toBe(404)
    expect(syncZettlePurchases).not.toHaveBeenCalled()
  })

  describe('DELETE /disconnect', () => {
    it('returns 401 without a user', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })
      const res = await findRoute('DELETE', '/disconnect').handler(
        makeRequest('DELETE', {}),
        makeContext(supabase),
      )
      expect(res.status).toBe(401)
      expect(createServiceClientNoCookies).not.toHaveBeenCalled()
    })

    it('returns 404 when the company has no connection', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      serviceReturning({ data: [] })
      const res = await findRoute('DELETE', '/disconnect').handler(
        makeRequest('DELETE', {}),
        makeContext(supabase),
      )
      expect(res.status).toBe(404)
      expect(disconnectApplication).not.toHaveBeenCalled()
    })

    it('reads the refresh token on the service role, revokes remotely, then revokes locally on the session', async () => {
      const { supabase, enqueue, findCall } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      const service = serviceReturning({
        data: [{ id: 'c1', status: 'active', organization_uuid: 'org-1', refresh_token_encrypted: 'enc' }],
      })
      enqueue({ data: null }) // local revoke (session client)
      const ctx = makeContext(supabase)
      const res = await findRoute('DELETE', '/disconnect').handler(makeRequest('DELETE', {}), ctx)
      expect(res.status).toBe(200)
      // Lookup: service role, pinned to the caller's company.
      expect(service.findCall('zettle_connections', 'select')?.[0]).toContain('refresh_token_encrypted')
      expect(service.findCall('zettle_connections', 'eq')).toEqual(['company_id', 'company-1'])
      expect(findCall('zettle_connections', 'select')).toBeUndefined()
      expect(refreshAccessToken).toHaveBeenCalledWith('plain-refresh')
      expect(disconnectApplication).toHaveBeenCalledWith('access-1')
      // The local revoke stays on the session client (RLS + writer-role trigger).
      expect(findCall('zettle_connections', 'update')?.[0]).toMatchObject({
        status: 'revoked',
        refresh_token_encrypted: null,
      })
      expect(service.findCall('zettle_connections', 'update')).toBeUndefined()
      expect(ctx.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'zettle.disconnected' }))
    })
  })
})
