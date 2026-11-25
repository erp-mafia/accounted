import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
const service = createQueuedMockSupabase()
const requireAuthMock = vi.fn()
const sendEmailMock = vi.fn()
const isConfiguredMock = vi.fn()
const logErrorMock = vi.hoisted(() => vi.fn())
const planRuleMock = vi.hoisted(() => vi.fn())
const paysMock = vi.hoisted(() => vi.fn())
const memberEmailMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => service.supabase,
}))
vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({
    sendEmail: (...args: unknown[]) => sendEmailMock(...args),
    isConfigured: () => isConfiguredMock(),
  }),
}))
vi.mock('@/lib/invoices/peppol-plan-rule', () => ({
  applyPeppolPlanRule: (...args: unknown[]) => planRuleMock(...args),
  peppolCompanyPays: (...args: unknown[]) => paysMock(...args),
}))
vi.mock('@/lib/notifications/member-email', () => ({
  resolveMemberEmail: (...args: unknown[]) => memberEmailMock(...args),
}))
vi.mock('@/lib/email/brand-sender', () => ({
  getSenderForCompany: vi.fn().mockResolvedValue({ fromName: null, fromAddress: null, replyTo: null, brand: null }),
  getBaseUrlForBrand: () => 'https://app.example.test',
}))
vi.mock('@/lib/logger', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: logErrorMock,
    child: (): unknown => logger,
  }
  return { createLogger: () => logger }
})

import { POST } from '../route'

const user = { id: 'user-1', email: 'owner@example.test' }
const companySettings = { company_name: 'Kund AB', org_number: '556677-8899', entity_type: 'aktiebolag' }
const enabledRow = (extra: Record<string, unknown> = {}) => ({
  company_id: 'company-1',
  status: 'enabled',
  max_sends: 10,
  receive_enabled: true,
  requested_at: '2026-08-21T15:00:00.000Z',
  requested_by: 'user-1',
  request_note: 'Vi fakturerar Region Skåne',
  enabled_at: '2026-08-21T15:00:01.000Z',
  enabled_by: 'automatic: paid plan',
  disabled_at: null,
  note: null,
  created_at: '2026-08-21T15:00:00.000Z',
  updated_at: '2026-08-21T15:00:01.000Z',
  ...extra,
})
const requestedRow = {
  company_id: 'company-1',
  status: 'requested',
  max_sends: null,
  receive_enabled: false,
  requested_at: '2026-08-21T15:00:00.000Z',
  requested_by: 'user-1',
  request_note: null,
  enabled_at: null,
  enabled_by: null,
  disabled_at: null,
  note: null,
  created_at: '2026-08-21T15:00:00.000Z',
  updated_at: '2026-08-21T15:00:00.000Z',
}

describe('POST /api/settings/peppol/access', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    service.reset()
    isConfiguredMock.mockReturnValue(true)
    sendEmailMock.mockResolvedValue({ success: true })
    planRuleMock.mockResolvedValue({ enabled: [], paused: [], failed: [] })
    paysMock.mockResolvedValue(false)
    memberEmailMock.mockResolvedValue('owner@example.test')
    requireAuthMock.mockResolvedValue({ user, supabase: mockSupabase, error: null })
  })

  function post(body: unknown = {}) {
    return POST(createMockRequest('/api/settings/peppol/access', { method: 'POST', body }), createMockRouteParams({}))
  }

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await post()).status).toBe(401)
  })

  it('rejects an oversized note', async () => {
    const response = await post({ note: 'x'.repeat(2001) })
    expect(response.status).toBe(400)
  })

  it('refuses the sandbox', async () => {
    enqueue({ data: { is_sandbox: true }, error: null })
    const response = await post()
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('PEPPOL_SANDBOX_NOT_ALLOWED')
  })

  it('switches Peppol on at once for a paying company, with its receiving choice, and mails nobody', async () => {
    enqueue({ data: { is_sandbox: false }, error: null })                         // sandbox check
    enqueue({ data: companySettings, error: null })                               // company settings
    service.enqueue({ data: null, error: null })                                  // no access row
    service.enqueue({ data: requestedRow, error: null })                          // upsert
    service.enqueue({ data: enabledRow(), error: null })                          // summary read
    service.enqueue({ data: null, error: null, count: 0 })                        // sends this month
    service.enqueue({ data: null, error: null, count: 0 })
    planRuleMock.mockResolvedValue({ enabled: ['company-1'], paused: [], failed: [] })

    const response = await post({ note: 'Vi fakturerar Region Skåne', wants_receiving: true })
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body.data.access).toMatchObject({ status: 'enabled', send_enabled: true, receive_enabled: true, max_sends: 10 })
    expect(body.data.plan_required).toBe(false)
    expect(planRuleMock).toHaveBeenCalledWith({ service: service.supabase, companyIds: ['company-1'] })
    expect(sendEmailMock).not.toHaveBeenCalled()
    const upsert = service.calls.find((c) => c.method === 'upsert')?.args[0] as Record<string, unknown>
    expect(upsert).toMatchObject({ request_note: 'Vi fakturerar Region Skåne', receive_enabled: true })
  })

  it('keeps the request of a company without a paid plan, says so, and mails the person who asked', async () => {
    enqueue({ data: { is_sandbox: false }, error: null })
    enqueue({ data: companySettings, error: null })
    service.enqueue({ data: null, error: null })                                  // no access row
    service.enqueue({ data: requestedRow, error: null })                          // upsert
    service.enqueue({ data: requestedRow, error: null })                          // summary read

    const response = await post()
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(body.data.access).toMatchObject({ status: 'requested', send_enabled: false })
    expect(body.data.plan_required).toBe(true)
    expect(memberEmailMock).toHaveBeenCalledWith(service.supabase, 'company-1', 'user-1')
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    const mail = sendEmailMock.mock.calls[0][0] as { to: string; subject: string; text: string; html: string; idempotencyKey: string }
    expect(mail.to).toBe('owner@example.test')
    expect(mail.subject).toBe('Peppol kräver ett betalt abonnemang')
    expect(mail.text).toContain('Kund AB')
    expect(mail.text).toContain('https://app.example.test/settings/billing')
    expect(mail.html).toContain('https://app.example.test/settings/billing')
    expect(mail.idempotencyKey).toBe('peppol_plan_required:company-1:user-1')
  })

  it('still answers the request when the mail fails: the page says the same', async () => {
    enqueue({ data: { is_sandbox: false }, error: null })
    enqueue({ data: companySettings, error: null })
    service.enqueue({ data: null, error: null })
    service.enqueue({ data: requestedRow, error: null })
    service.enqueue({ data: requestedRow, error: null })
    sendEmailMock.mockRejectedValue(new Error('provider down'))

    const response = await post()
    expect(response.status).toBe(201)
    expect((await response.json()).data.plan_required).toBe(true)
  })

  it('refuses again a company the operators switched off', async () => {
    enqueue({ data: { is_sandbox: false }, error: null })
    enqueue({ data: companySettings, error: null })
    service.enqueue({ data: { ...requestedRow, status: 'disabled', disabled_at: '2026-11-14T10:00:00.000Z' }, error: null })

    const response = await post()
    expect(response.status).toBe(403)
    expect((await response.json()).error.code).toBe('PEPPOL_ACCESS_DISABLED')
    expect(service.calls.some((c) => c.method === 'upsert')).toBe(false)
    expect(planRuleMock).not.toHaveBeenCalled()
  })

  it('refuses a sole trader identified by personnummer: nothing recorded, nobody mailed', async () => {
    enqueue({ data: { is_sandbox: false }, error: null })                         // sandbox check
    enqueue({ data: { company_name: 'Firma', org_number: '800101-1234', entity_type: 'enskild_firma' }, error: null })

    const response = await post({ wants_receiving: true })
    expect(response.status).toBe(422)
    expect((await response.json()).error.code).toBe('PEPPOL_REGISTRATION_PERSONAL_NUMBER')
    expect(service.calls.some((c) => c.method === 'upsert')).toBe(false)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('refuses an enskild firma by its legal form even when the stored number is not personnummer-shaped', async () => {
    enqueue({ data: { is_sandbox: false }, error: null })
    enqueue({ data: { company_name: 'Firma', org_number: '198001011234', entity_type: 'enskild_firma' }, error: null })

    const response = await post()
    expect(response.status).toBe(422)
    expect((await response.json()).error.code).toBe('PEPPOL_REGISTRATION_PERSONAL_NUMBER')
    expect(service.calls.some((c) => c.method === 'upsert')).toBe(false)
  })

  it('refuses a company without settings as missing an organisation number', async () => {
    enqueue({ data: { is_sandbox: false }, error: null })
    enqueue({ data: null, error: null })

    const response = await post()
    expect(response.status).toBe(422)
    expect((await response.json()).error.code).toBe('PEPPOL_REGISTRATION_ORG_NUMBER_REQUIRED')
    expect(service.calls.some((c) => c.method === 'upsert')).toBe(false)
  })

  it('answers a failed settings read as a server error and records nothing', async () => {
    enqueue({ data: { is_sandbox: false }, error: null })
    enqueue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })

    const response = await post({ wants_receiving: true })
    expect(response.status).toBe(503) // a statement timeout is transient
    expect(service.calls.some((c) => c.method === 'upsert')).toBe(false)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('is idempotent for a repeated request (no second e-mail) and 409 when already enabled', async () => {
    enqueue({ data: { is_sandbox: false }, error: null })
    enqueue({ data: companySettings, error: null })
    service.enqueue({ data: requestedRow, error: null })
    service.enqueue({ data: requestedRow, error: null })
    const again = await post()
    expect(again.status).toBe(200)
    expect((await again.json()).data.plan_required).toBe(true)
    expect(sendEmailMock).not.toHaveBeenCalled()

    reset(); service.reset()
    enqueue({ data: { is_sandbox: false }, error: null })
    enqueue({ data: companySettings, error: null })
    service.enqueue({ data: { ...requestedRow, status: 'enabled', enabled_at: '2026-08-21T16:00:00.000Z' }, error: null })
    const enabled = await post()
    expect(enabled.status).toBe(409)
    expect((await enabled.json()).error.code).toBe('PEPPOL_ACCESS_ALREADY_ENABLED')
  })
})
