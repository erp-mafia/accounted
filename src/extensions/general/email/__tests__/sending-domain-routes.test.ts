import { describe, it, expect, vi, beforeEach } from 'vitest'
import { emailExtension } from '@/extensions/general/email'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

const claimMock = vi.fn()
const verifyMock = vi.fn()
const removeMock = vi.fn()
const getMock = vi.fn()
const updateMock = vi.fn()
const webhookApplyMock = vi.fn()

vi.mock('@/extensions/general/email/lib/sending-domains', () => ({
  claimSendingDomain: (...args: unknown[]) => claimMock(...args),
  checkSendingDomainVerification: (...args: unknown[]) => verifyMock(...args),
  removeSendingDomain: (...args: unknown[]) => removeMock(...args),
  getSendingDomain: (...args: unknown[]) => getMock(...args),
  updateSendingDomainSettings: (...args: unknown[]) => updateMock(...args),
  applySendingDomainStatusFromWebhook: (...args: unknown[]) => webhookApplyMock(...args),
}))

const hasCapabilityMock = vi.fn()
vi.mock('@/lib/entitlements/has-capability', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/has-capability')>(
    '@/lib/entitlements/has-capability',
  )
  return {
    ...actual,
    hasCapability: (...args: unknown[]) => hasCapabilityMock(...args),
    requireCapability: async (supabase: unknown, companyId: string, key: string) =>
      (await hasCapabilityMock(supabase, companyId, key)) ? null : actual.capabilityBlockedResponse(key as never),
  }
})

const isSandboxMock = vi.fn()
vi.mock('@/lib/sandbox/guard', () => ({
  isSandboxCompany: (...args: unknown[]) => isSandboxMock(...args),
}))

// The delivery webhook path is covered by delivery-webhook.test.ts; here we
// only need the domain.updated branch, so the signature check is stubbed.
const verifyWebhookMock = vi.fn()
vi.mock('@/extensions/general/email/lib/delivery-webhook', async () => {
  const actual = await vi.importActual<typeof import('@/extensions/general/email/lib/delivery-webhook')>(
    '@/extensions/general/email/lib/delivery-webhook',
  )
  return {
    ...actual,
    isDeliveryWebhookConfigured: () => true,
    verifyDeliveryWebhook: (...args: unknown[]) => verifyWebhookMock(...args),
  }
})

vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => ({ rpc: vi.fn().mockResolvedValue({ data: null, error: null }) }),
}))

function findRoute(method: string, path: string) {
  return emailExtension.apiRoutes!.find((r) => r.method === method && r.path === path)!
}

function buildCtx(supabase: unknown, overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'email',
    supabase: supabase as ExtensionContext['supabase'],
    emit: vi.fn(),
    settings: { get: vi.fn(), set: vi.fn() },
    storage: { from: vi.fn() } as unknown as ExtensionContext['storage'],
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ExtensionContext['log'],
    services: {},
    ...overrides,
  } as ExtensionContext
}

const ROW = {
  id: 'row-1',
  company_id: 'company-1',
  domain: 'hansbolag.example',
  status: 'pending',
  sender_local_part: 'faktura',
  sender_name: null,
  enabled: true,
  resend_domain_id: 'rd_1',
  dns_records: [],
  verified_at: null,
  last_checked_at: null,
}

/** A context whose supabase answers the admin-role lookup with `role`. */
function adminCtx(role: 'owner' | 'admin' | 'member' = 'owner') {
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: { role } })
  return buildCtx(supabase)
}

beforeEach(() => {
  vi.clearAllMocks()
  hasCapabilityMock.mockResolvedValue(true)
  isSandboxMock.mockResolvedValue(false)
})

describe('GET /sending-domain', () => {
  const route = findRoute('GET', '/sending-domain')

  it('returns 401 without context', async () => {
    const res = await route.handler(createMockRequest('/sending-domain'), undefined)
    expect(res.status).toBe(401)
  })

  it('returns 403 capability_blocked without the opt-in grant (the UI hides on this)', async () => {
    hasCapabilityMock.mockResolvedValue(false)
    const { supabase } = createQueuedMockSupabase()
    const res = await route.handler(createMockRequest('/sending-domain'), buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ capability_blocked: boolean; capability: string }>(res)
    expect(status).toBe(403)
    expect(body.capability_blocked).toBe(true)
    expect(body.capability).toBe('custom_sender_domain')
    expect(getMock).not.toHaveBeenCalled()
  })

  it('returns the current row (or null) for any member with the grant', async () => {
    getMock.mockResolvedValue(ROW)
    const { supabase } = createQueuedMockSupabase()
    const res = await route.handler(createMockRequest('/sending-domain'), buildCtx(supabase))
    const { status, body } = await parseJsonResponse<{ data: typeof ROW }>(res)
    expect(status).toBe(200)
    expect(body.data.domain).toBe('hansbolag.example')
    expect(getMock).toHaveBeenCalledWith(expect.anything(), 'company-1')
  })
})

describe('POST /sending-domain', () => {
  const route = findRoute('POST', '/sending-domain')
  const request = () =>
    createMockRequest('/sending-domain', { method: 'POST', body: { domain: 'hansbolag.example' } })

  it('returns 403 for a plain member', async () => {
    const res = await route.handler(request(), adminCtx('member'))
    expect(res.status).toBe(403)
    expect(claimMock).not.toHaveBeenCalled()
  })

  it('returns 403 for a sandbox company', async () => {
    isSandboxMock.mockResolvedValue(true)
    const res = await route.handler(request(), adminCtx())
    expect(res.status).toBe(403)
    expect(claimMock).not.toHaveBeenCalled()
  })

  it('returns 400 on an invalid body', async () => {
    const res = await route.handler(
      createMockRequest('/sending-domain', { method: 'POST', body: { domain: '' } }),
      adminCtx(),
    )
    expect(res.status).toBe(400)
  })

  it('claims the domain for an admin', async () => {
    claimMock.mockResolvedValue({ ok: true, data: ROW })
    const res = await route.handler(request(), adminCtx('admin'))
    const { status, body } = await parseJsonResponse<{ data: typeof ROW }>(res)
    expect(status).toBe(200)
    expect(body.data.id).toBe('row-1')
    // (tenant RLS client, service-role writer, company, domain)
    expect(claimMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'company-1', 'hansbolag.example')
  })

  it('propagates the helper status code', async () => {
    claimMock.mockResolvedValue({ ok: false, status: 409, error: 'Domänen är redan registrerad.' })
    const res = await route.handler(request(), adminCtx())
    expect(res.status).toBe(409)
  })
})

describe('POST /sending-domain/verify', () => {
  const route = findRoute('POST', '/sending-domain/verify')

  it('returns 404 when no domain exists', async () => {
    verifyMock.mockResolvedValue({ ok: false, status: 404, error: 'Ingen avsändardomän är registrerad.' })
    const res = await route.handler(createMockRequest('/sending-domain/verify', { method: 'POST' }), adminCtx())
    expect(res.status).toBe(404)
  })

  it('returns the re-checked row', async () => {
    verifyMock.mockResolvedValue({ ok: true, data: { ...ROW, status: 'verified' } })
    const res = await route.handler(createMockRequest('/sending-domain/verify', { method: 'POST' }), adminCtx())
    const { status, body } = await parseJsonResponse<{ data: typeof ROW }>(res)
    expect(status).toBe(200)
    expect(body.data.status).toBe('verified')
  })
})

describe('PATCH /sending-domain', () => {
  const route = findRoute('PATCH', '/sending-domain')

  it('rejects unknown keys with 400', async () => {
    const res = await route.handler(
      createMockRequest('/sending-domain', { method: 'PATCH', body: { domain: 'x.example' } }),
      adminCtx(),
    )
    expect(res.status).toBe(400)
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('passes the validated patch through', async () => {
    updateMock.mockResolvedValue({ ok: true, data: { ...ROW, enabled: false } })
    const res = await route.handler(
      createMockRequest('/sending-domain', { method: 'PATCH', body: { enabled: false, sender_name: null } }),
      adminCtx(),
    )
    expect(res.status).toBe(200)
    expect(updateMock).toHaveBeenCalledWith(expect.anything(), 'company-1', { enabled: false, sender_name: null })
  })
})

describe('DELETE /sending-domain', () => {
  const route = findRoute('DELETE', '/sending-domain')

  it('returns 403 for a plain member', async () => {
    const res = await route.handler(createMockRequest('/sending-domain', { method: 'DELETE' }), adminCtx('member'))
    expect(res.status).toBe(403)
    expect(removeMock).not.toHaveBeenCalled()
  })

  it('removes for an owner', async () => {
    removeMock.mockResolvedValue({ ok: true, data: { removed: true } })
    const res = await route.handler(createMockRequest('/sending-domain', { method: 'DELETE' }), adminCtx())
    const { status, body } = await parseJsonResponse<{ data: { removed: boolean } }>(res)
    expect(status).toBe(200)
    expect(body.data.removed).toBe(true)
  })
})

describe('POST /delivery-status: domain.updated', () => {
  const route = findRoute('POST', '/delivery-status')

  it('applies domain.updated to sending-domain rows and reports the match', async () => {
    process.env.RESEND_DELIVERY_WEBHOOK_SECRET = 'whsec_test'
    verifyWebhookMock.mockReturnValue({
      type: 'domain.updated',
      created_at: '2026-08-22T10:00:00Z',
      data: { id: 'rd_1', name: 'hansbolag.example', status: 'verified', records: [] },
    })
    webhookApplyMock.mockResolvedValue('applied')
    const res = await route.handler(
      createMockRequest('/delivery-status', { method: 'POST', body: { type: 'domain.updated' } }),
      undefined,
    )
    const { status, body } = await parseJsonResponse<{ data: { applied: boolean } }>(res)
    expect(status).toBe(200)
    expect(body.data.applied).toBe(true)
    expect(webhookApplyMock).toHaveBeenCalledWith(expect.anything(), { id: 'rd_1', status: 'verified', records: [] })
  })

  it('acknowledges an unknown domain with 200 but answers 500 on a database error so Svix retries', async () => {
    process.env.RESEND_DELIVERY_WEBHOOK_SECRET = 'whsec_test'
    verifyWebhookMock.mockReturnValue({
      type: 'domain.updated',
      created_at: '2026-08-22T10:00:00Z',
      data: { id: 'rd_other', name: 'other.example', status: 'verified', records: [] },
    })
    const request = () =>
      createMockRequest('/delivery-status', { method: 'POST', body: { type: 'domain.updated' } })

    webhookApplyMock.mockResolvedValue('no_match')
    const ignored = await parseJsonResponse<{ data: { applied: boolean; reason: string } }>(
      await route.handler(request(), undefined),
    )
    expect(ignored.status).toBe(200)
    expect(ignored.body.data).toEqual({ applied: false, reason: 'no_matching_domain' })

    webhookApplyMock.mockResolvedValue('error')
    const failed = await route.handler(request(), undefined)
    expect(failed.status).toBe(500)
  })
})
