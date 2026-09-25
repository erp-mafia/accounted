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

// Default to "MFA not enforced" so existing tests authenticate normally;
// the AAL2-gate regression test below flips this on.
vi.mock('@/lib/auth/mfa', () => ({
  shouldEnforceMfa: vi.fn(() => false),
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

import { createClient } from '@/lib/supabase/server'
import { shouldEnforceMfa } from '@/lib/auth/mfa'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { requiredCapabilityForExtensionId } from '@/lib/extensions/sectors'
import { extensionRegistry } from '@/lib/extensions/registry'
import { GET, POST } from '../route'

const mockCreateClient = vi.mocked(createClient)
const mockShouldEnforceMfa = vi.mocked(shouldEnforceMfa)
const mockRequireCapability = vi.mocked(requireCapability)
const mockRequiredCapabilityForExtensionId = vi.mocked(requiredCapabilityForExtensionId)

function createPathParams(path: string[]) {
  return { params: Promise.resolve({ path }) }
}

describe('Extension Catch-All Route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // clearAllMocks doesn't reset implementations: re-assert the default so the
    // AAL2 test's mockReturnValue(true) can't leak into later cases.
    mockShouldEnforceMfa.mockReturnValue(false)
    // Default: capability present (allowed). Gated-extension tests override this.
    mockRequireCapability.mockResolvedValue(null)
    // Default: extension requires no capability, so the gate is a no-op and
    // existing dispatch tests behave as before. Paywall tests override this.
    mockRequiredCapabilityForExtensionId.mockReturnValue(undefined)
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
    // MFA is required for this user, but only AAL1 has been reached.
    mockShouldEnforceMfa.mockReturnValue(true)
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

  // A Swedish JSON body sent without a declared charset is read as Latin-1 by
  // clients that fall back that way, and "är" arrives as "Ã¤r". The bytes were
  // always right; only the declaration was missing.
  it('declares charset=utf-8 on JSON so Swedish text cannot be read as Latin-1', async () => {
    // The feature flag is checked after the extension is found, so the
    // disabled path needs a registered skatteverket to reach.
    extensionRegistry.register({
      id: 'skatteverket',
      name: 'Skatteverket',
      version: '1.0.0',
      apiRoutes: [{ method: 'GET', path: '/status', handler: vi.fn() }],
    })

    const request = createMockRequest('/api/extensions/ext/skatteverket/status')
    const response = await GET(request, createPathParams(['skatteverket', 'status']))

    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')

    // The body still decodes as UTF-8, and reading those same bytes as Latin-1
    // is what produced the reported mojibake.
    const bytes = new Uint8Array(await response.clone().arrayBuffer())
    expect(new TextDecoder('utf-8').decode(bytes)).toContain('miljö')
    expect(new TextDecoder('latin1').decode(bytes)).toContain('miljÃ¶')
  })

  it('leaves a non-JSON content-type alone', async () => {
    const handler = vi.fn().mockResolvedValue(
      new NextResponse('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } })
    )

    extensionRegistry.register({
      id: 'test-ext',
      name: 'Test',
      version: '1.0.0',
      apiRoutes: [{ method: 'GET', path: '/file', handler }],
    })

    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    })
    mockCreateClient.mockResolvedValue(supabase as never)

    const request = createMockRequest('/api/extensions/ext/test-ext/file')
    const response = await GET(request, createPathParams(['test-ext', 'file']))

    expect(response.headers.get('content-type')).toBe('application/pdf')
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
})
