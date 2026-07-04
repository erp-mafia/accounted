import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

// The custom-domain routes are gated off by default (product decision
// 2026-07-02): enable the flag for the behavior tests, and prove the gate
// itself in the last describe.
beforeEach(() => {
  process.env.INBOX_CUSTOM_DOMAINS_ENABLED = 'true'
})
afterEach(() => {
  delete process.env.INBOX_CUSTOM_DOMAINS_ENABLED
})

const claimMock = vi.fn()
const verifyMock = vi.fn()
const removeMock = vi.fn()
const getMock = vi.fn()

vi.mock('@/extensions/general/invoice-inbox/lib/custom-domains', async () => {
  const actual = await vi.importActual<
    typeof import('@/extensions/general/invoice-inbox/lib/custom-domains')
  >('@/extensions/general/invoice-inbox/lib/custom-domains')
  return {
    ...actual,
    claimCustomDomain: (...args: unknown[]) => claimMock(...args),
    checkCustomDomainVerification: (...args: unknown[]) => verifyMock(...args),
    removeCustomDomain: (...args: unknown[]) => removeMock(...args),
    getCustomDomain: (...args: unknown[]) => getMock(...args),
  }
})

vi.mock('@/lib/rate-limits/inbox', () => ({
  checkInboxUploadRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))

function findRoute(method: string, path: string) {
  return invoiceInboxExtension.apiRoutes!.find(
    (r) => r.method === method && r.path === path
  )!
}

function buildCtx(supabase: unknown, overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'invoice-inbox',
    supabase: supabase as ExtensionContext['supabase'],
    emit: vi.fn(),
    settings: { get: vi.fn(), set: vi.fn() },
    storage: { from: vi.fn() } as unknown as ExtensionContext['storage'],
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ExtensionContext['log'],
    services: {},
    ...overrides,
  } as ExtensionContext
}

const DOMAIN_ROW = {
  id: 'row-1',
  company_id: 'company-1',
  domain: 'hansbolag.example',
  status: 'pending',
  resend_domain_id: 'rd_1',
  dns_records: [],
  verified_at: null,
  last_checked_at: null,
}

describe('GET /inbox/domain', () => {
  const route = findRoute('GET', '/inbox/domain')

  beforeEach(() => vi.clearAllMocks())

  it('returns 401 without context', async () => {
    const res = await route.handler(createMockRequest('/inbox/domain'), undefined)
    expect(res.status).toBe(401)
  })

  it('returns the current domain row (or null)', async () => {
    getMock.mockResolvedValue(DOMAIN_ROW)
    const { supabase } = createQueuedMockSupabase()
    const res = await route.handler(createMockRequest('/inbox/domain'), buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ data: typeof DOMAIN_ROW }>(res)
    expect(status).toBe(200)
    expect(body.data.domain).toBe('hansbolag.example')
    expect(getMock).toHaveBeenCalledWith(expect.anything(), 'company-1')
  })
})

describe('POST /inbox/domain', () => {
  const route = findRoute('POST', '/inbox/domain')

  beforeEach(() => vi.clearAllMocks())

  it('returns 403 for non-admin members', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { role: 'member' } })
    const request = createMockRequest('/inbox/domain', {
      method: 'POST',
      body: { domain: 'hansbolag.example' },
    })
    const res = await route.handler(request, buildCtx(supabase))
    expect(res.status).toBe(403)
    expect(claimMock).not.toHaveBeenCalled()
  })

  it('claims the domain for admins', async () => {
    claimMock.mockResolvedValue({ ok: true, data: DOMAIN_ROW })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { role: 'admin' } })
    const request = createMockRequest('/inbox/domain', {
      method: 'POST',
      body: { domain: 'hansbolag.example' },
    })
    const res = await route.handler(request, buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ data: typeof DOMAIN_ROW }>(res)
    expect(status).toBe(200)
    expect(body.data.id).toBe('row-1')
    expect(claimMock).toHaveBeenCalledWith(expect.anything(), 'company-1', 'hansbolag.example')
  })

  it('maps lib failures to their status codes', async () => {
    claimMock.mockResolvedValue({ ok: false, status: 409, error: 'Domänen är redan registrerad.' })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { role: 'owner' } })
    const request = createMockRequest('/inbox/domain', {
      method: 'POST',
      body: { domain: 'hansbolag.example' },
    })
    const res = await route.handler(request, buildCtx(supabase))
    expect(res.status).toBe(409)
  })

  it('rejects a missing domain field with 400', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { role: 'owner' } })
    const request = createMockRequest('/inbox/domain', { method: 'POST', body: {} })
    const res = await route.handler(request, buildCtx(supabase))
    expect(res.status).toBe(400)
    expect(claimMock).not.toHaveBeenCalled()
  })

  it('blocks sandbox companies from claiming a domain', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { role: 'owner' } }) // company_members role check
    enqueue({ data: { is_sandbox: true } }) // company_settings sandbox check
    const request = createMockRequest('/inbox/domain', {
      method: 'POST',
      body: { domain: 'hansbolag.example' },
    })
    const res = await route.handler(request, buildCtx(supabase))
    expect(res.status).toBe(403)
    expect(claimMock).not.toHaveBeenCalled()
  })
})

describe('POST /inbox/domain/verify', () => {
  const route = findRoute('POST', '/inbox/domain/verify')

  beforeEach(() => vi.clearAllMocks())

  it('returns 403 for viewers', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { role: 'viewer' } })
    const res = await route.handler(
      createMockRequest('/inbox/domain/verify', { method: 'POST' }),
      buildCtx(supabase),
    )
    expect(res.status).toBe(403)
  })

  it('re-checks verification for admins', async () => {
    verifyMock.mockResolvedValue({ ok: true, data: { ...DOMAIN_ROW, status: 'verified' } })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { role: 'admin' } })
    const res = await route.handler(
      createMockRequest('/inbox/domain/verify', { method: 'POST' }),
      buildCtx(supabase),
    )
    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(res)
    expect(status).toBe(200)
    expect(body.data.status).toBe('verified')
  })
})

describe('DELETE /inbox/domain', () => {
  const route = findRoute('DELETE', '/inbox/domain')

  beforeEach(() => vi.clearAllMocks())

  it('returns 403 for non-admin members', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { role: 'member' } })
    const res = await route.handler(
      createMockRequest('/inbox/domain', { method: 'DELETE' }),
      buildCtx(supabase),
    )
    expect(res.status).toBe(403)
    expect(removeMock).not.toHaveBeenCalled()
  })

  it('removes the domain for owners', async () => {
    removeMock.mockResolvedValue({ ok: true, data: { removed: true } })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { role: 'owner' } })
    const res = await route.handler(
      createMockRequest('/inbox/domain', { method: 'DELETE' }),
      buildCtx(supabase),
    )
    const { status, body } = await parseJsonResponse<{ data: { removed: boolean } }>(res)
    expect(status).toBe(200)
    expect(body.data.removed).toBe(true)
  })

  it('surfaces a Resend removal failure without deleting the row', async () => {
    removeMock.mockResolvedValue({ ok: false, status: 502, error: 'Kunde inte ta bort domänen.' })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { role: 'owner' } })
    const res = await route.handler(
      createMockRequest('/inbox/domain', { method: 'DELETE' }),
      buildCtx(supabase),
    )
    expect(res.status).toBe(502)
  })
})

describe('INBOX_CUSTOM_DOMAINS_ENABLED gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.INBOX_CUSTOM_DOMAINS_ENABLED
  })

  it('returns 403 FEATURE_DISABLED on every /inbox/domain route when the flag is off', async () => {
    const { supabase } = createQueuedMockSupabase()
    const routes: Array<[string, string]> = [
      ['GET', '/inbox/domain'],
      ['POST', '/inbox/domain'],
      ['POST', '/inbox/domain/verify'],
      ['DELETE', '/inbox/domain'],
    ]
    for (const [method, path] of routes) {
      const res = await findRoute(method, path).handler(
        createMockRequest(path, { method }),
        buildCtx(supabase),
      )
      const { status, body } = await parseJsonResponse<{ code: string }>(res)
      expect(status).toBe(403)
      expect(body.code).toBe('FEATURE_DISABLED')
    }
    expect(getMock).not.toHaveBeenCalled()
    expect(claimMock).not.toHaveBeenCalled()
    expect(verifyMock).not.toHaveBeenCalled()
    expect(removeMock).not.toHaveBeenCalled()
  })
})
