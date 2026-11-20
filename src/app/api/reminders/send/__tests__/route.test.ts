import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, createMockRouteParams, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase } = createTableMockSupabase()
const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
const flags = vi.hoisted(() => ({ sending: true }))
vi.mock('@/lib/invoices/reminders-enabled', () => ({
  get REMINDERS_SENDING_ENABLED() {
    return flags.sending
  },
}))
vi.mock('@/lib/sandbox/guard', () => ({ guardSandbox: vi.fn(async () => null) }))
vi.mock('@/lib/entitlements/has-capability', () => ({ requireCapability: vi.fn(async () => null) }))
const emailConfigured = vi.hoisted(() => ({ value: true }))
vi.mock('@/lib/email/service', () => ({ getEmailService: async () => ({ isConfigured: () => emailConfigured.value, sendEmail: vi.fn() }) }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({}) }))
const dispatchMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/reminders/dispatch', () => ({ dispatchReminder: dispatchMock }))

import { POST } from '../route'
import { ReminderInvoiceNotFoundError } from '@/lib/reminders/facts'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const post = (body: unknown) => POST(createMockRequest('/api/reminders/send', { method: 'POST', body }), createMockRouteParams({}))

beforeEach(() => {
  vi.clearAllMocks()
  flags.sending = true
  emailConfigured.value = true
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

describe('POST /api/reminders/send', () => {
  it('returns 401 when not authenticated', async () => {
    const { NextResponse } = await import('next/server')
    requireAuthMock.mockResolvedValue({ user: null, supabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await post({ invoice_ids: [A] })).status).toBe(401)
  })

  it('returns 400 without invoices', async () => {
    expect((await post({ invoice_ids: [] })).status).toBe(400)
    expect((await post({ invoice_ids: ['nope'] })).status).toBe(400)
  })

  it('refuses while reminders cannot be sent, or mail is not set up', async () => {
    flags.sending = false
    expect((await post({ invoice_ids: [A] })).status).toBe(409)
    flags.sending = true
    emailConfigured.value = false
    expect((await post({ invoice_ids: [A] })).status).toBeGreaterThanOrEqual(400)
    expect(dispatchMock).not.toHaveBeenCalled()
  })

  it("sends each picked invoice once as the person's own pick, and answers each outcome", async () => {
    dispatchMock
      .mockResolvedValueOnce({ status: 'sent', reminderId: 'rem-a', level: 1, providerMessageId: 'm', recorded: true })
      .mockRejectedValueOnce(new ReminderInvoiceNotFoundError())
    const res = await post({ invoice_ids: [A, B, A], bank_attested: true })
    expect(res.status).toBe(200)
    const { body } = await parseJsonResponse<{ data: { results: unknown[] } }>(res)
    expect(body.data.results).toEqual([
      expect.objectContaining({ invoice_id: A, status: 'sent', level: 1 }),
      { invoice_id: B, status: 'skipped', reason: 'not_found' },
    ])
    expect(dispatchMock.mock.calls.map(([, input]) => input)).toEqual([
      { companyId: 'company-1', invoiceId: A, actorUserId: 'user-1', mode: 'manual', bankAttested: true },
      { companyId: 'company-1', invoiceId: B, actorUserId: 'user-1', mode: 'manual', bankAttested: true },
    ])
  })
})
