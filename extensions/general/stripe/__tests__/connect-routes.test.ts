import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Force the capability gate to run (no dev bypass) but stub requireCapability
// so entitlement is controlled per test. Mirrors the enable-banking suite.
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, requireCapability: vi.fn().mockResolvedValue(null) }
})

// Never let a unit test reach the Stripe API: deauthorize is mocked, the pure
// env-derived helpers (buildAuthorizeUrl, isStripeConnectConfigured) stay real.
vi.mock('../lib/connect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/connect')>()
  return { ...actual, deauthorizeAccount: vi.fn().mockResolvedValue(undefined) }
})

import { stripeExtension } from '../index'
import { requireCapability, capabilityBlockedResponse } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { deauthorizeAccount } from '../lib/connect'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

function findRoute(method: string, path: string) {
  const route = stripeExtension.apiRoutes?.find((r) => r.method === method && r.path === path)
  expect(route, `${method} ${path} must be registered`).toBeDefined()
  return route!
}

function makeRequest(method: string, body?: unknown): Request {
  return new Request('https://test.local/api/extensions/ext/stripe/x', {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

function makeContext(supabase: unknown): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'stripe',
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

describe('stripe extension routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireCapability).mockResolvedValue(null)
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_123')
    vi.stubEnv('STRIPE_CONNECT_CLIENT_ID', 'ca_test_123')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('POST /connect', () => {
    it('returns 401 without a user', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', {}),
        makeContext(supabase),
      )
      expect(res.status).toBe(401)
    })

    it('blocks anonymous (sandbox) users before any external call', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({
        data: { user: { id: 'user-1', is_anonymous: true } },
        error: null,
      })
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', {}),
        makeContext(supabase),
      )
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.sandbox_blocked).toBe(true)
    })

    it('blocks sandbox companies', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: true } }) // company_settings
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', {}),
        makeContext(supabase),
      )
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.sandbox_blocked).toBe(true)
    })

    it('returns 403 capability_blocked when not entitled', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      vi.mocked(requireCapability).mockResolvedValue(
        capabilityBlockedResponse(CAPABILITY.stripe_payments),
      )
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', {}),
        makeContext(supabase),
      )
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.capability_blocked).toBe(true)
      expect(body.capability).toBe(CAPABILITY.stripe_payments)
    })

    it('returns 503 when Connect is not configured', async () => {
      vi.stubEnv('STRIPE_CONNECT_CLIENT_ID', '')
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', {}),
        makeContext(supabase),
      )
      expect(res.status).toBe(503)
    })

    it('returns 409 when an active connection already exists', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      enqueue({
        data: [{ id: 'conn-1', status: 'active', created_at: new Date().toISOString() }],
      })
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', {}),
        makeContext(supabase),
      )
      expect(res.status).toBe(409)
    })

    it('returns 409 when a fresh pending connection exists (double-click guard)', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      enqueue({
        data: [{ id: 'conn-1', status: 'pending', created_at: new Date().toISOString() }],
      })
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', {}),
        makeContext(supabase),
      )
      expect(res.status).toBe(409)
    })

    it('stages a pending connection and returns the Stripe authorize URL', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: { is_sandbox: false } })
      enqueue({ data: [] }) // no existing connections
      enqueue({ data: { id: 'conn-new' } }) // insert
      const res = await findRoute('POST', '/connect').handler(
        makeRequest('POST', {}),
        makeContext(supabase),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { url: string }
      const url = new URL(body.url)
      expect(url.origin + url.pathname).toBe('https://connect.stripe.com/oauth/authorize')
      expect(url.searchParams.get('client_id')).toBe('ca_test_123')
      expect(url.searchParams.get('scope')).toBe('read_write')
      expect(url.searchParams.get('state')).toBeTruthy()
      expect(url.searchParams.get('redirect_uri')).toBe(
        'http://localhost:3000/api/extensions/stripe/callback',
      )
    })
  })

  describe('DELETE /disconnect', () => {
    it('returns 404 when no connection exists', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({ data: [] })
      const res = await findRoute('DELETE', '/disconnect').handler(
        makeRequest('DELETE', {}),
        makeContext(supabase),
      )
      expect(res.status).toBe(404)
    })

    it('deauthorizes an active connection and marks it revoked', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({
        data: [{ id: 'conn-1', status: 'active', stripe_account_id: 'acct_1' }],
      })
      enqueue({ data: null, error: null }) // update -> revoked
      const ctx = makeContext(supabase)
      const res = await findRoute('DELETE', '/disconnect').handler(
        makeRequest('DELETE', { connection_id: 'conn-1' }),
        ctx,
      )
      expect(res.status).toBe(200)
      expect(vi.mocked(deauthorizeAccount)).toHaveBeenCalledWith('acct_1')
      expect(ctx.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stripe.disconnected' }),
      )
    })

    it('still revokes locally when Stripe deauthorize fails', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      vi.mocked(deauthorizeAccount).mockRejectedValueOnce(new Error('already revoked'))
      enqueue({
        data: [{ id: 'conn-1', status: 'active', stripe_account_id: 'acct_1' }],
      })
      enqueue({ data: null, error: null })
      const res = await findRoute('DELETE', '/disconnect').handler(
        makeRequest('DELETE', {}),
        makeContext(supabase),
      )
      expect(res.status).toBe(200)
    })
  })

  describe('GET /status', () => {
    it('returns 401 without a user', async () => {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })
      const res = await findRoute('GET', '/status').handler(
        makeRequest('GET'),
        makeContext(supabase),
      )
      expect(res.status).toBe(401)
    })

    it('prefers the active connection and reports configured', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: USER }, error: null })
      enqueue({
        data: [
          { id: 'conn-2', status: 'error', stripe_account_id: null },
          { id: 'conn-1', status: 'active', stripe_account_id: 'acct_1', livemode: true },
        ],
      })
      const res = await findRoute('GET', '/status').handler(
        makeRequest('GET'),
        makeContext(supabase),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        configured: boolean
        connection: { id: string } | null
      }
      expect(body.configured).toBe(true)
      expect(body.connection?.id).toBe('conn-1')
    })
  })
})
