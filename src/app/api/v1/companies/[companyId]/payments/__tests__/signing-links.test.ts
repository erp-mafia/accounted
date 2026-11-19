/**
 * The payment signing link through the v1 door of the operation registry
 * (src/lib/operations/payment-signing-links.ts):
 *   POST /api/v1/companies/:companyId/payments/signing-links
 *
 * Auth, scope, idempotency and the envelope are withApiV1's; the rules are
 * lib/payments/orders/signing-links.ts's. The signing itself has no door:
 * the link answers where the firmatecknare signs with BankID.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }), isMembershipDormant: () => false }
})
const door = vi.hoisted(() => ({ openPaymentsDoor: vi.fn() }))
vi.mock('@/lib/payments/orders/switched-on', () => door)
vi.mock('@/lib/email/brand-sender', () => ({
  getBaseUrlForCompany: vi.fn().mockResolvedValue('https://app.accounted.se'),
  getSenderForCompany: vi.fn().mockResolvedValue({ fromName: null, fromAddress: null, replyTo: null, brand: null }),
}))
const mail = vi.hoisted(() => ({ sendEmail: vi.fn(), isConfigured: vi.fn().mockReturnValue(true) }))
vi.mock('@/lib/email/service', () => ({ getEmailService: vi.fn().mockResolvedValue(mail) }))
const writer = vi.hoisted(() => ({ client: null as unknown }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => writer.client }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase } from '@/tests/helpers'
import { POST as createLink } from '../signing-links/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LINK_ID = 'c2222222-2222-4222-8222-222222222222'
const O1 = 'b1111111-1111-4111-8111-111111111111'
const O2 = 'b1111111-1111-4111-8111-222222222222'
const URL_BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/payments/signing-links`

const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const VIEWERISH_MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }

function orderRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    user_id: 'someone-else',
    status: 'approved',
    batch_id: null,
    amount: 737.5,
    currency: 'SEK',
    cash_account_id: 'acct-1',
    requested_execution_date: '2026-10-20',
    payee_type: 'bankgiro',
    payee_bankgiro: '50501055',
    payee_name: 'Derome Bygg AB',
    reference_type: 'ocr',
    reference: '4400112233',
    outcome_unknown_at: null,
    created_at: '2026-10-14T08:00:00Z',
    debtor_snapshot: { iban: 'SE3550000000054910000003', bank_name: 'SEB' },
    ...overrides,
  }
}

function request(body: unknown, options: { query?: string; idempotency?: boolean } = {}): Request {
  return new Request(`${URL_BASE}${options.query ?? ''}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      ...(options.idempotency === false ? {} : { 'Idempotency-Key': crypto.randomUUID() }),
      'Content-Type': 'application/json',
    },
  })
}

const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }

function client(byTable: Record<string, { data?: unknown; error?: unknown } | Array<{ data?: unknown; error?: unknown }>> = {}) {
  const db = createTableMockSupabase({
    company_members: OWNER,
    payment_orders: { data: [orderRow(O1), orderRow(O2)] },
    payment_signing_links: [{ data: [] }, { data: { id: LINK_ID } }, { data: null }],
    companies: { data: { name: 'Bolaget AB', team_id: null } },
    profiles: { data: { full_name: 'Karin Byråsson' } },
    ...byTable,
  })
  mockServiceClient.mockReturnValue(db.supabase)
  writer.client = db.supabase
  return db
}

function authOk(scopes: string[]) {
  mockValidate.mockResolvedValue({ userId: 'user-1', keyId: 'key-1', keyName: 'Test key', scopes, mode: 'live' })
}

beforeEach(() => {
  vi.clearAllMocks()
  door.openPaymentsDoor.mockResolvedValue({ ok: true, provider: { id: 'open_payments' } })
  mail.isConfigured.mockReturnValue(true)
  mail.sendEmail.mockResolvedValue({ success: true, messageId: 'm-1' })
  authOk(['suppliers:read', 'suppliers:write'])
})

describe('POST /payments/signing-links', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ valid: false, error: 'invalid' })
    client()
    expect((await createLink(request({ payment_order_ids: [O1] }), params)).status).toBe(401)
  })

  it('403 INSUFFICIENT_SCOPE without suppliers:write', async () => {
    authOk(['suppliers:read'])
    client()
    expect((await createLink(request({ payment_order_ids: [O1] }), params)).status).toBe(403)
  })

  it('404 when the key user is not a member of the company', async () => {
    client({ company_members: { data: null } })
    expect((await createLink(request({ payment_order_ids: [O1] }), params)).status).toBe(404)
  })

  it('400 VALIDATION_ERROR for a malformed body, and for a write without an Idempotency-Key', async () => {
    const db = client()
    for (const body of [{}, { payment_order_ids: [] }, { payment_order_ids: ['x'] }, { payment_order_ids: [O1], recipient_email: 'nope' }, { payment_order_ids: [O1], note: 'x'.repeat(501) }]) {
      const res = await createLink(request(body), params)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    }
    expect((await createLink(request({ payment_order_ids: [O1, O2] }, { idempotency: false }), params)).status).toBe(400)
    expect(db.payloads('payment_signing_links', 'insert')).toEqual([])
  })

  it('403 FORBIDDEN for a member who did not prepare the orders, before anything is stored', async () => {
    const db = client({ company_members: VIEWERISH_MEMBER })
    const res = await createLink(request({ payment_order_ids: [O1, O2] }), params)
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('FORBIDDEN')
    expect(db.payloads('payment_signing_links', 'insert')).toEqual([])
  })

  it('409 for an order that is not approved', async () => {
    const db = client({ payment_orders: { data: [orderRow(O1), orderRow(O2, { status: 'draft' })] } })
    const res = await createLink(request({ payment_order_ids: [O1, O2] }), params)
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('PAYMENT_ORDERS_WRONG_STATUS')
    expect(db.payloads('payment_signing_links', 'insert')).toEqual([])
  })

  it('?dry_run=true answers the basket and mints nothing', async () => {
    const db = client()
    const res = await createLink(request({ payment_order_ids: [O1, O2], recipient_email: 'anna@example.se' }, { query: '?dry_run=true' }), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    const preview = (body.preview ?? body.data?.preview ?? body.data) as Record<string, unknown>
    expect(preview).toMatchObject({ order_count: 2, total_amount: 1475, currency: 'SEK', email_will_be_sent: true, valid_hours: 72, url: null })
    expect(db.payloads('payment_signing_links', 'insert')).toEqual([])
    expect(mail.sendEmail).not.toHaveBeenCalled()
  })

  it('mints the link for an owner (201), mails it, and answers the url once', async () => {
    const db = client()
    const res = await createLink(request({ payment_order_ids: [O1, O2], recipient_email: 'Anna@Example.se', note: 'Oktober' }), params)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data).toMatchObject({ signing_link_id: LINK_ID, email_sent: true, order_count: 2, total_amount: 1475, currency: 'SEK' })
    expect(body.data.url).toMatch(/^https:\/\/app\.accounted\.se\/betala\/[A-Za-z0-9_-]{43}$/)
    const [inserted] = db.payloads('payment_signing_links', 'insert') as Array<Record<string, unknown>>
    expect(inserted).toMatchObject({ company_id: COMPANY_ID, created_by: 'user-1', recipient_email: 'anna@example.se', note: 'Oktober', order_ids: [O1, O2] })
    expect(inserted.token_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(mail.sendEmail).toHaveBeenCalledTimes(1)
    const sent = mail.sendEmail.mock.calls[0]![0] as { to: string; subject: string; text: string }
    expect(sent.to).toBe('anna@example.se')
    expect(sent.subject).toBe('Signera 2 betalningar från Bolaget AB med BankID')
    expect(sent.text).toContain(body.data.url)
  })
})
