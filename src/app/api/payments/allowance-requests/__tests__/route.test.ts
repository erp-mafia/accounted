import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'

const state = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof import('@/tests/helpers').createTableMockSupabase> }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(state.db.supabase),
  createServiceClient: () => state.db.supabase,
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: (...args: unknown[]) => requireWriteMock(...args) }))
const mail = vi.hoisted(() => ({ isConfigured: vi.fn(), sendEmail: vi.fn() }))
vi.mock('@/lib/email/service', () => ({ getEmailService: vi.fn().mockResolvedValue(mail) }))

import { requireAuth } from '@/lib/auth/require-auth'
import { POST } from '../route'

const user = { id: 'user-1', email: 'anna@bygg.se' }
type ErrorBody = { error: { code: string; message: string } }

const post = (body: unknown) => POST(createMockRequest('/api/payments/allowance-requests', { method: 'POST', body }), createMockRouteParams({}))

beforeEach(() => {
  vi.clearAllMocks()
  state.db = createTableMockSupabase({
    bank_payment_allowance_requests: [{ data: [] }, { data: { id: 'r-1', created_at: '2026-10-14T10:00:00.000Z' } }],
    payment_orders: { data: Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, cash_account_id: 'acct-1' })) },
    companies: { data: { name: 'Bygg AB', org_number: '556677-8899' } },
  })
  vi.mocked(requireAuth).mockResolvedValue({ user: user as never, supabase: state.db.supabase as never, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
  mail.isConfigured.mockReturnValue(true)
  mail.sendEmail.mockResolvedValue({ success: true, messageId: 'm-1' })
})

describe('POST /api/payments/allowance-requests', () => {
  it('is 401 without a session and stores nothing', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ user: null as never, supabase: state.db.supabase as never, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const response = await post({ monthly_payments_wanted: 40 })
    expect(response.status).toBe(401)
    expect(state.db.payloads('bank_payment_allowance_requests', 'insert')).toEqual([])
    expect(mail.sendEmail).not.toHaveBeenCalled()
  })

  it.each([
    ['no number', {}],
    ['a number below one', { monthly_payments_wanted: 0 }],
    ['a fraction', { monthly_payments_wanted: 12.5 }],
    ['a message that is too long', { monthly_payments_wanted: 40, message: 'x'.repeat(2001) }],
  ])('is 400 for %s', async (_name, body) => {
    const response = await post(body)
    expect(response.status).toBe(400)
    expect(state.db.payloads('bank_payment_allowance_requests', 'insert')).toEqual([])
  })

  it('is 201 with the request id: the request is stored in the person\'s name and support is mailed', async () => {
    const { status, body } = await parseJsonResponse<{ data: { request_id: string } }>(await post({ monthly_payments_wanted: 40, message: '  Vi betalar många leverantörer  ' }))
    expect(status).toBe(201)
    expect(body.data.request_id).toBe('r-1')
    expect(state.db.payloads('bank_payment_allowance_requests', 'insert')).toEqual([
      { company_id: 'company-1', requested_by: 'user-1', monthly_payments_wanted: 40, message: 'Vi betalar många leverantörer' },
    ])
    expect(mail.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ replyTo: 'anna@bygg.se', text: expect.stringContaining('556677-8899') }))
    expect(requireWriteMock).toHaveBeenCalled()
  })

  it('is 409 for a second request while the company\'s first is unanswered and younger than a day', async () => {
    state.db.setTable('bank_payment_allowance_requests', { data: [{ id: 'r-0', created_at: new Date().toISOString() }] })
    const { status, body } = await parseJsonResponse<ErrorBody>(await post({ monthly_payments_wanted: 40 }))
    expect(status).toBe(409)
    expect(body.error.code).toBe('BANK_PAYMENTS_ALLOWANCE_REQUEST_OPEN')
    expect(body.error.message).toMatch(/redan en förfrågan/)
    expect(state.db.payloads('bank_payment_allowance_requests', 'insert')).toEqual([])
    expect(mail.sendEmail).not.toHaveBeenCalled()
  })

  it('is 503 when the mail cannot be sent, and the request is removed again', async () => {
    mail.sendEmail.mockResolvedValue({ success: false, error: 'down' })
    const { status, body } = await parseJsonResponse<ErrorBody>(await post({ monthly_payments_wanted: 40 }))
    expect(status).toBe(503)
    expect(body.error.code).toBe('BANK_PAYMENTS_ALLOWANCE_REQUEST_NOT_SENT')
    expect(state.db.findCalls('bank_payment_allowance_requests', 'delete')).toHaveLength(1)
  })
})
