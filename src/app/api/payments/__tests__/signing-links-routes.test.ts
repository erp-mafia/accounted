/**
 * The session routes of the payment signing link: GET and POST
 * /api/payments/signing-links (the open links, and Be någon annan signera)
 * and DELETE /api/payments/signing-links/:id (Avbryt länken). The rules live
 * in lib/payments/orders/signing-links.ts and are tested there; here the
 * doors: a session, the body, the not-found answer and what reaches the
 * service.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
  createServiceClient: () => mockSupabase,
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
const service = vi.hoisted(() => ({
  issuePaymentSigningLink: vi.fn(),
  listOpenPaymentSigningLinks: vi.fn(),
  cancelPaymentSigningLink: vi.fn(),
}))
vi.mock('@/lib/payments/orders/signing-links', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/orders/signing-links')>()),
  ...service,
}))

import { GET as listLinks, POST as issueLink } from '../signing-links/route'
import { DELETE as cancelLink } from '../signing-links/[id]/route'

const ORDER = '11111111-1111-4111-8111-111111111111'
const LINK = '22222222-2222-4222-8222-222222222222'
const noParams = { params: Promise.resolve({}) }
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const post = (body: unknown) => createMockRequest('/api/payments/signing-links', { method: 'POST', body })

type ErrorBody = { error: { code: string } }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
  service.issuePaymentSigningLink.mockResolvedValue({
    ok: true,
    created: true,
    data: { signing_link_id: LINK, url: 'https://app.accounted.se/betala/abc', expires_at: '2026-10-17T09:00:00.000Z', email_sent: true, order_count: 1, total_amount: 737.5, currency: 'SEK' },
  })
  service.listOpenPaymentSigningLinks.mockResolvedValue([{ signing_link_id: LINK, recipient_email: 'anna@example.se', payment_order_ids: [ORDER] }])
  service.cancelPaymentSigningLink.mockResolvedValue({ ok: true, data: { signing_link_id: LINK, cancelled: true } })
})

describe('payment signing link routes without a session', () => {
  it.each([
    ['GET /api/payments/signing-links', () => listLinks(createMockRequest('/api/payments/signing-links'), noParams)],
    ['POST /api/payments/signing-links', () => issueLink(post({ order_ids: [ORDER] }), noParams)],
    ['DELETE /api/payments/signing-links/:id', () => cancelLink(createMockRequest(`/api/payments/signing-links/${LINK}`, { method: 'DELETE' }), params(LINK))],
  ])('%s answers 401', async (_name, call) => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    expect((await call()).status).toBe(401)
    expect(service.issuePaymentSigningLink).not.toHaveBeenCalled()
    expect(service.cancelPaymentSigningLink).not.toHaveBeenCalled()
  })
})

describe('POST /api/payments/signing-links', () => {
  it('validates the orders, the address and the note', async () => {
    for (const body of [{}, { order_ids: [] }, { order_ids: ['not-a-uuid'] }, { order_ids: [ORDER], recipient_email: 'not-an-email' }, { order_ids: [ORDER], note: 'x'.repeat(501) }]) {
      expect((await issueLink(post(body), noParams)).status, JSON.stringify(body)).toBe(400)
    }
    expect(service.issuePaymentSigningLink).not.toHaveBeenCalled()
  })

  it('makes the link as the person signed in for the active company, and answers the url', async () => {
    const { status, body } = await parseJsonResponse<{ data: { url: string; email_sent: boolean } }>(
      await issueLink(post({ order_ids: [ORDER], recipient_email: 'anna@example.se', note: 'Oktober' }), noParams),
    )
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ url: 'https://app.accounted.se/betala/abc', email_sent: true })
    expect(service.issuePaymentSigningLink).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }), {
      orderIds: [ORDER],
      recipientEmail: 'anna@example.se',
      note: 'Oktober',
    })
  })

  it('answers a refusal of the rules in its envelope', async () => {
    service.issuePaymentSigningLink.mockResolvedValue({ ok: false, code: 'PAYMENT_SIGNING_LINK_ALREADY_OPEN' })
    const { status, body } = await parseJsonResponse<ErrorBody>(await issueLink(post({ order_ids: [ORDER] }), noParams))
    expect(status).toBe(409)
    expect(body.error.code).toBe('PAYMENT_SIGNING_LINK_ALREADY_OPEN')
  })
})

describe('GET /api/payments/signing-links', () => {
  it('lists the open links of the active company', async () => {
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(await listLinks(createMockRequest('/api/payments/signing-links'), noParams))
    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(service.listOpenPaymentSigningLinks).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1' }))
  })
})

describe('DELETE /api/payments/signing-links/:id', () => {
  it('answers 404 for a malformed id without asking the service, and for an unknown link', async () => {
    const malformed = await parseJsonResponse<ErrorBody>(await cancelLink(createMockRequest('/api/payments/signing-links/x', { method: 'DELETE' }), params('x')))
    expect(malformed.status).toBe(404)
    expect(malformed.body.error.code).toBe('PAYMENT_SIGNING_LINK_NOT_FOUND')
    expect(service.cancelPaymentSigningLink).not.toHaveBeenCalled()
    service.cancelPaymentSigningLink.mockResolvedValue({ ok: false, code: 'PAYMENT_SIGNING_LINK_NOT_FOUND' })
    expect((await cancelLink(createMockRequest(`/api/payments/signing-links/${LINK}`, { method: 'DELETE' }), params(LINK))).status).toBe(404)
  })

  it('cancels the link as the person signed in', async () => {
    const { status, body } = await parseJsonResponse<{ data: { cancelled: boolean } }>(
      await cancelLink(createMockRequest(`/api/payments/signing-links/${LINK}`, { method: 'DELETE' }), params(LINK)),
    )
    expect(status).toBe(200)
    expect(body.data.cancelled).toBe(true)
    expect(service.cancelPaymentSigningLink).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }), { signingLinkId: LINK })
  })
})
