import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The capability gate runs, entitlement is set per test.
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, requireCapability: vi.fn().mockResolvedValue(null) }
})
// The staged key is read and the proof written on the service client.
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn() }))
// The dispatcher's session, for the unauthenticated case.
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))

import { woocommerceExtension } from '../index'
import { encryptCredential } from '../lib/credentials'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createClient } from '@/lib/supabase/server'
import { extensionRegistry } from '@/lib/extensions/registry'
import { POST as dispatch } from '@/app/api/extensions/ext/[...path]/route'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

const CONN = '123e4567-e89b-12d3-a456-426614174000'
// What WooCommerce mints; its admin lists the key as "***1a2b3c4".
const KEY = 'ck_0123456789abcdef0123456789abcdef01a2b3c4'

function verifyStore() {
  const route = woocommerceExtension.apiRoutes?.find(
    (r) => r.method === 'POST' && r.path === '/verify-store',
  )
  expect(route, 'POST /verify-store must be registered').toBeDefined()
  return route!
}

function makeRequest(body: unknown): Request {
  return new Request('https://test.local/api/extensions/ext/woocommerce/verify-store', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** A member's context; its session client answers the sandbox check. */
function makeContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  const session = createQueuedMockSupabase()
  session.enqueue({ data: { is_sandbox: false } })
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'woocommerce',
    requestId: 'req_test',
    supabase: session.supabase,
    emit: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

/** The service client the route creates, answering `results` in order. */
function serviceReturning(...results: Array<{ data?: unknown; error?: unknown }>) {
  const service = createQueuedMockSupabase()
  for (const result of results) service.enqueue(result)
  vi.mocked(createServiceClientNoCookies).mockReturnValue(service.supabase as never)
  return service
}

/** The pending row the callback left: keys staged, started by user-1 just now. */
function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONN,
    user_id: 'user-1',
    created_at: new Date().toISOString(),
    consumer_key_encrypted: encryptCredential(KEY),
    ...overrides,
  }
}

const ACTIVATED = {
  id: CONN,
  company_id: 'company-1',
  user_id: 'user-1',
  store_url: 'https://shop.example.se',
}

describe('POST /api/extensions/ext/woocommerce/verify-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('WOOCOMMERCE_CREDENTIALS_ENCRYPTION_KEY', 'test-key')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    extensionRegistry.clear()
  })

  it('answers 401 without a session and never reads a connection', async () => {
    extensionRegistry.register(woocommerceExtension)
    const getUser = vi.fn().mockResolvedValue({ data: { user: null }, error: null })
    vi.mocked(createClient).mockResolvedValue({ auth: { getUser } } as never)

    const res = await dispatch(
      new Request('http://localhost:3000/api/extensions/ext/woocommerce/verify-store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: CONN, key_suffix: '1a2b3c4' }),
      }),
      { params: Promise.resolve({ path: ['woocommerce', 'verify-store'] }) },
    )

    expect(res.status).toBe(401)
    expect(createServiceClientNoCookies).not.toHaveBeenCalled()
  })

  it('blocks a sandbox session before reading anything', async () => {
    const res = await verifyStore().handler(
      makeRequest({ connection_id: CONN, key_suffix: '1a2b3c4' }),
      makeContext({ isAnonymous: true }),
    )
    expect(res.status).toBe(403)
    expect(createServiceClientNoCookies).not.toHaveBeenCalled()
  })

  it.each([
    ['no body', {}],
    ['a short suffix', { connection_id: CONN, key_suffix: '1a2b3c' }],
    ['a whole key', { connection_id: CONN, key_suffix: KEY }],
    ['a connection id that is not a uuid', { connection_id: 'conn-1', key_suffix: '1a2b3c4' }],
  ])('answers 400 for %s and never reads a connection', async (_case, body) => {
    const res = await verifyStore().handler(makeRequest(body), makeContext())
    expect(res.status).toBe(400)
    expect(createServiceClientNoCookies).not.toHaveBeenCalled()
  })

  it("answers 404 when no pending connection of the caller's company has that id", async () => {
    const service = serviceReturning({ data: null })

    const res = await verifyStore().handler(
      makeRequest({ connection_id: CONN, key_suffix: '1a2b3c4' }),
      makeContext(),
    )

    expect(res.status).toBe(404)
    const eqCalls = service.calls.filter((c) => c.method === 'eq').map((c) => c.args)
    expect(eqCalls).toContainEqual(['id', CONN])
    expect(eqCalls).toContainEqual(['company_id', 'company-1'])
    expect(eqCalls).toContainEqual(['status', 'pending'])
    expect(service.findCalls('woocommerce_connections', 'update')).toHaveLength(0)
  })

  it('refuses a colleague: only the session that started the handshake can finish it', async () => {
    const service = serviceReturning({ data: pendingRow({ user_id: 'user-2' }) })

    const res = await verifyStore().handler(
      makeRequest({ connection_id: CONN, key_suffix: '1a2b3c4' }),
      makeContext(),
    )

    expect(res.status).toBe(403)
    expect(service.findCalls('woocommerce_connections', 'update')).toHaveLength(0)
  })

  it('parks a handshake past its TTL instead of taking a proof for it', async () => {
    const service = serviceReturning(
      { data: pendingRow({ created_at: new Date(Date.now() - 16 * 60_000).toISOString() }) },
      { data: null }, // park
    )

    const res = await verifyStore().handler(
      makeRequest({ connection_id: CONN, key_suffix: '1a2b3c4' }),
      makeContext(),
    )

    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('expired')
    const updates = service.findCalls('woocommerce_connections', 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0][0]).toMatchObject({
      status: 'error',
      oauth_state: null,
      consumer_key_encrypted: null,
      consumer_secret_encrypted: null,
    })
  })

  it('answers 409 while the store has not sent a key, and writes nothing', async () => {
    const service = serviceReturning({ data: pendingRow({ consumer_key_encrypted: null }) })

    const res = await verifyStore().handler(
      makeRequest({ connection_id: CONN, key_suffix: '1a2b3c4' }),
      makeContext(),
    )

    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('not_approved')
    expect(service.findCalls('woocommerce_connections', 'update')).toHaveLength(0)
  })

  it('does not take the store live for someone who cannot read its admin: a wrong suffix confirms and activates nothing', async () => {
    const ctx = makeContext()
    const service = serviceReturning({ data: pendingRow() })

    const res = await verifyStore().handler(
      makeRequest({ connection_id: CONN, key_suffix: 'fffffff' }),
      ctx,
    )

    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('suffix_mismatch')
    expect(service.findCalls('woocommerce_connections', 'update')).toHaveLength(0)
    expect(ctx.emit).not.toHaveBeenCalled()
  })

  it('takes the store live when the suffix matches as the admin shows it, under the initiator session', async () => {
    const ctx = makeContext()
    const service = serviceReturning(
      { data: pendingRow() },
      { data: null }, // record the proof
      { data: ACTIVATED }, // activateIfComplete
    )

    const res = await verifyStore().handler(
      makeRequest({ connection_id: CONN, key_suffix: '***1A2B3C4' }),
      ctx,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, connection_id: CONN })
    const updates = service.findCalls('woocommerce_connections', 'update')
    expect(updates).toHaveLength(2)
    expect(Object.keys(updates[0][0] as object)).toEqual(['browser_confirmed_at'])
    expect(updates[1][0]).toMatchObject({
      status: 'active',
      transaction_sync_enabled: true,
      oauth_state: null,
    })
    // The flip is the conditional one: pending, keys and the proof present.
    const notCalls = service.calls.filter((c) => c.method === 'not').map((c) => c.args)
    expect(notCalls).toContainEqual(['consumer_key_encrypted', 'is', null])
    expect(notCalls).toContainEqual(['browser_confirmed_at', 'is', null])
    expect(ctx.emit).toHaveBeenCalledWith({
      type: 'woocommerce.connected',
      payload: {
        connectionId: CONN,
        storeUrl: 'https://shop.example.se',
        userId: 'user-1',
        companyId: 'company-1',
      },
    })
  })

  it('parks the attempt and says so when the store is already connected to a company', async () => {
    const ctx = makeContext()
    const service = serviceReturning(
      { data: pendingRow() },
      { data: null }, // record the proof
      { data: null, error: { code: '23505', message: 'duplicate key' } }, // the flip
      { data: null }, // park
    )

    const res = await verifyStore().handler(
      makeRequest({ connection_id: CONN, key_suffix: '1a2b3c4' }),
      ctx,
    )

    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('conflict')
    const updates = service.findCalls('woocommerce_connections', 'update')
    expect(updates).toHaveLength(3)
    expect(updates[2][0]).toMatchObject({ status: 'error', consumer_key_encrypted: null })
    expect(ctx.emit).not.toHaveBeenCalled()
  })
})
