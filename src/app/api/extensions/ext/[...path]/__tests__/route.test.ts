import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
} from '@/tests/helpers'
import { NextResponse } from 'next/server'

// Mock dependencies
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/extensions/context-factory', () => ({
  createExtensionContext: vi.fn().mockReturnValue({
    userId: 'user-1',
    extensionId: 'test-ext',
  }),
}))

// Default to "no MFA gate applies" so existing tests authenticate normally;
// the AAL2-gate regression test below flips the step-up on.
vi.mock('@/lib/auth/mfa', () => ({
  shouldEnforceMfa: vi.fn(() => false),
  mfaStepUpApplies: vi.fn(() => false),
}))

// Drive the paywall gate directly. Keep the module's real exports (the resolver
// path reads keys.ts, not this module) and only stub requireCapability so a test
// can force "blocked" / "allowed" without seeding capability_grants rows.
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/has-capability')>()),
  requireCapability: vi.fn(),
}))

// Control which capability an extension requires directly, instead of depending
// on the generated extension registry: it is empty in the zero-extensions
// (core-only) build, which would otherwise make the gate a no-op here.
vi.mock('@/lib/extensions/sectors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/extensions/sectors')>()),
  requiredCapabilityForExtensionId: vi.fn(),
}))

// The role gates a route declares: driven directly, with the real 403 envelope.
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  requireWritePermission: vi.fn(),
  isCompanyAdmin: vi.fn(),
}))

import { createClient } from '@/lib/supabase/server'
import { isCompanyAdmin, requireWritePermission } from '@/lib/auth/require-write'
import { mfaStepUpApplies, shouldEnforceMfa } from '@/lib/auth/mfa'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { requiredCapabilityForExtensionId } from '@/lib/extensions/sectors'
import { extensionRegistry } from '@/lib/extensions/registry'
import { requireCompanyId } from '@/lib/company/context'
import { getActor } from '@/lib/bookkeeping/actor-context'
import { DELETE, GET, PATCH, POST, PUT } from '../route'

const mockCreateClient = vi.mocked(createClient)
const mockShouldEnforceMfa = vi.mocked(shouldEnforceMfa)
const mockMfaStepUpApplies = vi.mocked(mfaStepUpApplies)
const mockRequireCapability = vi.mocked(requireCapability)
const mockRequiredCapabilityForExtensionId = vi.mocked(requiredCapabilityForExtensionId)
const mockRequireWritePermission = vi.mocked(requireWritePermission)
const mockIsCompanyAdmin = vi.mocked(isCompanyAdmin)

function createPathParams(path: string[]) {
  return { params: Promise.resolve({ path }) }
}

describe('Extension Catch-All Route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // clearAllMocks doesn't reset implementations: re-assert the default so the
    // AAL2 test's mockReturnValue(true) can't leak into later cases.
    mockShouldEnforceMfa.mockReturnValue(false)
    mockMfaStepUpApplies.mockReturnValue(false)
    // Default: capability present (allowed). Gated-extension tests override this.
    mockRequireCapability.mockResolvedValue(null)
    // Default: extension requires no capability, so the gate is a no-op and
    // existing dispatch tests behave as before. Paywall tests override this.
    mockRequiredCapabilityForExtensionId.mockReturnValue(undefined)
    // Default: the caller may write. The viewer cases below override this.
    mockRequireWritePermission.mockResolvedValue({ ok: true })
    extensionRegistry.clear()
  })

  it('returns 400 for empty path', async () => {
    const request = createMockRequest('/api/extensions/ext/')
    const response = await GET(request, createPathParams([]))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
  })

  it('returns 404 for unknown extension', async () => {
    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })
    mockCreateClient.mockResolvedValue(supabase as never)

    const request = createMockRequest('/api/extensions/ext/nonexistent/foo')
    const response = await GET(request, createPathParams(['nonexistent', 'foo']))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(404)
  })

  it('returns 401 when not authenticated', async () => {
    extensionRegistry.register({
      id: 'test-ext',
      name: 'Test',
      version: '1.0.0',
      apiRoutes: [{ method: 'GET', path: '/data', handler: vi.fn() }],
    })

    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Not authenticated' },
    })
    mockCreateClient.mockResolvedValue(supabase as never)

    const request = createMockRequest('/api/extensions/ext/test-ext/data')
    const response = await GET(request, createPathParams(['test-ext', 'data']))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(401)
  })

  it('blocks a session that has not completed MFA (AAL2) and never dispatches the handler', async () => {
    // Regression for the audit fix: the dispatcher is the single chokepoint for
    // the whole extension surface, so an AAL1 (single-factor) session on hosted
    // must be rejected before any extension handler runs.
    const handler = vi.fn()
    extensionRegistry.register({
      id: 'test-ext',
      name: 'Test',
      version: '1.0.0',
      apiRoutes: [{ method: 'GET', path: '/data', handler }],
    })

    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1', app_metadata: {} } },
      error: null,
    })
    // The step-up applies to this user, but only AAL1 has been reached.
    mockShouldEnforceMfa.mockReturnValue(true)
    mockMfaStepUpApplies.mockReturnValue(true)
    ;(supabase.auth as unknown as { mfa: unknown }).mfa = {
      getAuthenticatorAssuranceLevel: vi
        .fn()
        .mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal2' } }),
    }
    mockCreateClient.mockResolvedValue(supabase as never)

    const request = createMockRequest('/api/extensions/ext/test-ext/data')
    const response = await GET(request, createPathParams(['test-ext', 'data']))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(403)
    expect(handler).not.toHaveBeenCalled()
  })

  it('returns 404 for unmatched method/path', async () => {
    extensionRegistry.register({
      id: 'test-ext',
      name: 'Test',
      version: '1.0.0',
      apiRoutes: [{ method: 'POST', path: '/data', handler: vi.fn() }],
    })

    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })
    mockCreateClient.mockResolvedValue(supabase as never)

    // GET doesn't match POST /data
    const request = createMockRequest('/api/extensions/ext/test-ext/data')
    const response = await GET(request, createPathParams(['test-ext', 'data']))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(404)
  })

  it('dispatches to matching handler with context', async () => {
    const handler = vi.fn().mockResolvedValue(
      NextResponse.json({ banks: [] })
    )

    extensionRegistry.register({
      id: 'enable-banking',
      name: 'Enable Banking',
      version: '1.0.0',
      apiRoutes: [{ method: 'GET', path: '/banks', handler }],
    })

    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })
    mockCreateClient.mockResolvedValue(supabase as never)

    const request = createMockRequest('/api/extensions/ext/enable-banking/banks')
    const response = await GET(request, createPathParams(['enable-banking', 'banks']))
    const { status, body } = await parseJsonResponse<{ banks: unknown[] }>(response)

    expect(status).toBe(200)
    expect(body.banks).toEqual([])
    expect(handler).toHaveBeenCalledWith(request, expect.objectContaining({
      extensionId: 'test-ext',
    }))
  })

  it('runs the handler as the signed-in user, named by id for the audit log of its service-role writes', async () => {
    let seen: ReturnType<typeof getActor>
    const handler = vi.fn(async () => {
      seen = getActor()
      return NextResponse.json({ ok: true })
    })

    extensionRegistry.register({
      id: 'test-ext',
      name: 'Test',
      version: '1.0.0',
      apiRoutes: [{ method: 'POST', path: '/book', handler }],
    })

    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })
    mockCreateClient.mockResolvedValue(supabase as never)

    const request = createMockRequest('/api/extensions/ext/test-ext/book', { method: 'POST', body: {} })
    const response = await POST(request, createPathParams(['test-ext', 'book']))

    expect(response.status).toBe(200)
    expect(seen).toEqual({ type: 'user', userId: 'user-1' })
    expect(getActor()).toBeUndefined()
  })

  it('dispatches POST requests correctly', async () => {
    const handler = vi.fn().mockResolvedValue(
      NextResponse.json({ ok: true })
    )

    extensionRegistry.register({
      id: 'test-ext',
      name: 'Test',
      version: '1.0.0',
      apiRoutes: [{ method: 'POST', path: '/connect', handler }],
    })

    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })
    mockCreateClient.mockResolvedValue(supabase as never)

    const request = createMockRequest('/api/extensions/ext/test-ext/connect', {
      method: 'POST',
      body: { foo: 'bar' },
    })
    const response = await POST(request, createPathParams(['test-ext', 'connect']))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(handler).toHaveBeenCalled()
  })

  // Paywall: the dispatcher gates every company-context route of an extension
  // that declares a required capability (invoice-inbox → ai). The resolver is
  // mocked so the test is deterministic in any build; requireCapability is
  // mocked to force the outcome.
  it('blocks a paid extension route when the company lacks the capability, before the handler runs', async () => {
    const handler = vi.fn()
    extensionRegistry.register({
      id: 'invoice-inbox',
      name: 'Dokumentinkorg',
      version: '1.0.0',
      apiRoutes: [{ method: 'GET', path: '/items', handler }],
    })

    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })
    mockCreateClient.mockResolvedValue(supabase as never)
    mockRequiredCapabilityForExtensionId.mockReturnValue('ai')
    mockRequireCapability.mockResolvedValue(
      NextResponse.json(
        { error: 'paid', capability_blocked: true, capability: 'ai' },
        { status: 403 },
      ),
    )

    const request = createMockRequest('/api/extensions/ext/invoice-inbox/items')
    const response = await GET(request, createPathParams(['invoice-inbox', 'items']))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(403)
    expect(handler).not.toHaveBeenCalled()
    expect(mockRequireCapability).toHaveBeenCalledWith(expect.anything(), 'company-1', 'ai')
  })

  it('dispatches a paid extension route when the company holds the capability', async () => {
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ data: [] }))
    extensionRegistry.register({
      id: 'invoice-inbox',
      name: 'Dokumentinkorg',
      version: '1.0.0',
      apiRoutes: [{ method: 'GET', path: '/items', handler }],
    })

    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })
    mockCreateClient.mockResolvedValue(supabase as never)
    mockRequiredCapabilityForExtensionId.mockReturnValue('ai')
    mockRequireCapability.mockResolvedValue(null) // capability present

    const request = createMockRequest('/api/extensions/ext/invoice-inbox/items')
    const response = await GET(request, createPathParams(['invoice-inbox', 'items']))

    expect(response.status).toBe(200)
    expect(handler).toHaveBeenCalled()
  })

  it('never gates the skipAuth ingestion webhook of a paid extension (freeze-and-retain)', async () => {
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }))
    extensionRegistry.register({
      id: 'invoice-inbox',
      name: 'Dokumentinkorg',
      version: '1.0.0',
      apiRoutes: [{ method: 'POST', path: '/inbound', handler, skipAuth: true }],
    })
    // Even if the gate would block, the skipAuth branch returns first.
    mockRequireCapability.mockResolvedValue(
      NextResponse.json({ capability_blocked: true }, { status: 403 }),
    )

    const request = createMockRequest('/api/extensions/ext/invoice-inbox/inbound', {
      method: 'POST',
      body: {},
    })
    const response = await POST(request, createPathParams(['invoice-inbox', 'inbound']))

    expect(response.status).toBe(200)
    expect(handler).toHaveBeenCalled()
    expect(mockRequireCapability).not.toHaveBeenCalled()
  })

  describe('declared role gates', () => {
    function signIn() {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
      mockCreateClient.mockResolvedValue(supabase as never)
    }

    function register(route: Record<string, unknown>) {
      extensionRegistry.register({
        id: 'test-ext',
        name: 'Test',
        version: '1.0.0',
        apiRoutes: [{ method: 'POST', path: '/write', ...route } as never],
      })
    }

    const call = () =>
      POST(
        createMockRequest('/api/extensions/ext/test-ext/write', { method: 'POST', body: {} }),
        createPathParams(['test-ext', 'write']),
      )

    it('refuses the invoicing-only role on any route before the handler runs', async () => {
      const handler = vi.fn()
      register({ handler })
      signIn()
      vi.mocked(requireCompanyId).mockImplementationOnce(async (_s, _u, facts) => {
        if (facts) facts.role = 'invoicer'
        return 'company-1'
      })

      const response = await call()

      expect(response.status).toBe(403)
      expect(JSON.stringify(await response.json())).toContain('INVOICER_ROUTE_NOT_ALLOWED')
      expect(handler).not.toHaveBeenCalled()
    })

    it('refuses a viewer on a requireWrite route before the handler runs', async () => {
      const handler = vi.fn()
      register({ requireWrite: true, handler })
      signIn()
      mockRequireWritePermission.mockResolvedValue({
        ok: false,
        response: NextResponse.json({ error: 'Du har endast läsbehörighet i detta företag.' }, { status: 403 }),
      })

      const response = await call()

      expect(response.status).toBe(403)
      expect(handler).not.toHaveBeenCalled()
      expect(mockRequireWritePermission).toHaveBeenCalledWith(expect.anything(), 'user-1', { companyId: 'company-1' })
    })

    it('dispatches a requireWrite route for a writer', async () => {
      const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }))
      register({ requireWrite: true, handler })
      signIn()
      mockRequireWritePermission.mockResolvedValue({ ok: true })

      const response = await call()

      expect(response.status).toBe(200)
      expect(handler).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ userId: 'user-1' }))
    })

    it('refuses a non-admin on a requireAdmin route with the FORBIDDEN envelope', async () => {
      const handler = vi.fn()
      register({ requireAdmin: true, handler })
      signIn()
      mockIsCompanyAdmin.mockResolvedValue(false)

      const response = await call()
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

      expect(status).toBe(403)
      expect(body.error.code).toBe('FORBIDDEN')
      expect(handler).not.toHaveBeenCalled()
      expect(mockIsCompanyAdmin).toHaveBeenCalledWith(expect.anything(), 'company-1')
      // requireAdmin implies requireWrite: one check, not two.
      expect(mockRequireWritePermission).not.toHaveBeenCalled()
    })

    it('dispatches a requireAdmin route for an owner or admin', async () => {
      const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }))
      register({ requireAdmin: true, handler })
      signIn()
      mockIsCompanyAdmin.mockResolvedValue(true)

      const response = await call()

      expect(response.status).toBe(200)
      expect(handler).toHaveBeenCalled()
    })

  })

  // A write method refuses viewers unless the route declares viewerMay, so a
  // route that forgets its gate is closed, not open. The real write check
  // runs here, fed the role the company resolver reports.
  describe('default viewer refusal on write methods', () => {
    const handlers = { GET, POST, PUT, PATCH, DELETE }
    type Method = keyof typeof handlers

    function signIn() {
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
      mockCreateClient.mockResolvedValue(supabase as never)
    }

    async function asRole(role: string) {
      const actual = await vi.importActual<typeof import('@/lib/auth/require-write')>('@/lib/auth/require-write')
      mockRequireWritePermission.mockImplementation(actual.requireWritePermission)
      vi.mocked(requireCompanyId).mockImplementationOnce(async (_s, _u, facts) => {
        if (facts) facts.role = role as never
        return 'company-1'
      })
    }

    function register(method: Method, route: Record<string, unknown>) {
      extensionRegistry.register({
        id: 'test-ext',
        name: 'Test',
        version: '1.0.0',
        apiRoutes: [{ method, path: '/thing', ...route } as never],
      })
    }

    const call = (method: Method) =>
      handlers[method](
        createMockRequest('/api/extensions/ext/test-ext/thing', method === 'GET' ? undefined : { method, body: {} }),
        createPathParams(['test-ext', 'thing']),
      )

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
      'refuses a viewer on an undeclared %s route before the handler runs',
      async (method) => {
        const handler = vi.fn()
        register(method, { handler })
        signIn()
        await asRole('viewer')

        const response = await call(method)
        const { status, body } = await parseJsonResponse<{ error: string }>(response)

        expect(status).toBe(403)
        expect(body.error).toBe('Du har endast läsbehörighet i detta företag.')
        expect(handler).not.toHaveBeenCalled()
      },
    )

    it('lets a member through on an undeclared write route', async () => {
      const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }))
      register('POST', { handler })
      signIn()
      await asRole('member')

      const response = await call('POST')

      expect(response.status).toBe(200)
      expect(handler).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ userId: 'user-1' }))
    })

    it('lets a viewer through on a write route that declares viewerMay', async () => {
      const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }))
      register('POST', { viewerMay: true, handler })
      signIn()
      await asRole('viewer')

      const response = await call('POST')

      expect(response.status).toBe(200)
      expect(handler).toHaveBeenCalled()
      expect(mockRequireWritePermission).not.toHaveBeenCalled()
    })

    it('still refuses a viewer on a requireWrite route that also says viewerMay', async () => {
      const handler = vi.fn()
      register('POST', { requireWrite: true, viewerMay: true, handler })
      signIn()
      await asRole('viewer')

      const response = await call('POST')

      expect(response.status).toBe(403)
      expect(handler).not.toHaveBeenCalled()
    })

    it('runs no role check on an undeclared GET route, so a viewer reads', async () => {
      const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }))
      register('GET', { handler })
      signIn()
      await asRole('viewer')

      const response = await call('GET')

      expect(response.status).toBe(200)
      expect(handler).toHaveBeenCalled()
      expect(mockRequireWritePermission).not.toHaveBeenCalled()
      expect(mockIsCompanyAdmin).not.toHaveBeenCalled()
    })

    it('dispatches a skipAuth write route (a webhook) without a session or a role check', async () => {
      const handler = vi.fn().mockResolvedValue(NextResponse.json({ received: true }))
      register('POST', { skipAuth: true, handler })
      const { supabase } = createQueuedMockSupabase()
      supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'no session' } })
      mockCreateClient.mockResolvedValue(supabase as never)

      const response = await call('POST')

      expect(response.status).toBe(200)
      expect(handler).toHaveBeenCalledTimes(1)
      expect(supabase.auth.getUser).not.toHaveBeenCalled()
      expect(requireCompanyId).not.toHaveBeenCalled()
      expect(mockRequireWritePermission).not.toHaveBeenCalled()
    })

    it('dispatches a skipCompanyContext write route (onboarding) without a role check', async () => {
      const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }))
      register('POST', { skipCompanyContext: true, handler })
      signIn()

      const response = await call('POST')

      expect(response.status).toBe(200)
      expect(handler).toHaveBeenCalledTimes(1)
      expect(requireCompanyId).not.toHaveBeenCalled()
      expect(mockRequireWritePermission).not.toHaveBeenCalled()
    })
  })
})
