/**
 * The token routes of the payment signing link under /api/betala/[token]:
 * the link is the authentication (a bad token is a 404, never a 401), the
 * limiter bounds a leaked link, the firmatecknare's typed personnummer is
 * required and the sender's number on file is never used, and every signing
 * call runs the same signing service as the session routes, as the sender,
 * for the link's company and the link's orders only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'
import { hashInviteToken } from '@/lib/bank-feed/invites'

const db = createTableMockSupabase()
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => db.supabase }))
vi.mock('@/lib/domains/trusted-app-origin', () => ({ resolveRequestAppOrigin: vi.fn().mockResolvedValue('https://app.accounted.se') }))

const signing = vi.hoisted(() => ({
  startPaymentSigning: vi.fn(),
  pollPaymentSigning: vi.fn(),
  restartPaymentSigning: vi.fn(),
}))
vi.mock('@/lib/payments/orders/signing', () => signing)

import { GET as basket } from '../[token]/route'
import { POST as start } from '../[token]/signing/route'
import { POST as poll } from '../[token]/signing/[id]/poll/route'
import { POST as restart } from '../[token]/signing/[id]/restart/route'

const LINK_ID = '22222222-2222-4222-8222-222222222222'
const COMPANY = '33333333-3333-4333-8333-333333333333'
const SENDER = '44444444-4444-4444-8444-444444444444'
const BATCH = '55555555-5555-4555-8555-555555555555'
const NEW_BATCH = '66666666-6666-4666-8666-666666666666'
const OTHER_BATCH = '77777777-7777-4777-8777-777777777777'
const O1 = '11111111-1111-4111-8111-111111111111'
const O2 = '11111111-1111-4111-8111-222222222222'
const PN = '199001011239'
const HOUR = 60 * 60 * 1000

let tokenCounter = 0
function freshToken(): string {
  tokenCounter += 1
  return `${String(tokenCounter).padStart(6, '0')}${'p'.repeat(37)}`
}

function link(overrides: Record<string, unknown> = {}) {
  return {
    id: LINK_ID,
    company_id: COMPANY,
    created_by: SENDER,
    recipient_email: 'anna@example.se',
    note: 'Oktober',
    order_ids: [O1, O2],
    total_amount: 1475,
    currency: 'SEK',
    expires_at: new Date(Date.now() + 72 * HOUR).toISOString(),
    mail_sent_at: null,
    batch_id: null,
    consumed_at: null,
    cancelled_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

function orderRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    user_id: SENDER,
    status: 'approved',
    batch_id: null,
    amount: 737.5,
    currency: 'SEK',
    cash_account_id: 'acct-1',
    requested_execution_date: '2026-10-20',
    payee_type: 'bankgiro',
    payee_bankgiro: '50501055',
    payee_plusgiro: null,
    payee_clearing: null,
    payee_account: null,
    payee_iban: null,
    payee_name: 'Derome Bygg AB',
    reference_type: 'ocr',
    reference: '4400112233',
    outcome_unknown_at: null,
    created_at: '2026-10-14T08:00:00Z',
    debtor_snapshot: { iban: 'SE3550000000054910000003', name: 'Företagskonto', bank_name: 'SEB' },
    ...overrides,
  }
}

const view = (status: string, batchId = BATCH) => ({ batch_id: batchId, status, challenge: null, failure_code: null, step: null, orders: [] })

const tokenParams = (token: string) => ({ params: Promise.resolve({ token }) })
const idParams = (token: string, id: string) => ({ params: Promise.resolve({ token, id }) })
const post = (url: string, body?: unknown) =>
  createMockRequest(url, { method: 'POST', ...(body === undefined ? {} : { body }), headers: { 'x-forwarded-for': '203.0.113.9', 'user-agent': 'Browser/1.0' } })

type ErrorBody = { error: { code: string } }

beforeEach(() => {
  vi.clearAllMocks()
  db.reset()
  db.setTable('companies', { data: { name: 'Bolaget AB', team_id: null } })
  db.setTable('profiles', { data: { full_name: 'Karin Byråsson' } })
  db.setTable('payment_orders', { data: [orderRow(O1), orderRow(O2)] })
  signing.startPaymentSigning.mockResolvedValue({ ok: true, data: view('awaiting_signature') })
  signing.pollPaymentSigning.mockResolvedValue({ ok: true, data: view('awaiting_signature') })
  signing.restartPaymentSigning.mockResolvedValue({ ok: true, data: view('awaiting_signature') })
})

describe('the payment signing token routes refuse what is not a live link', () => {
  it('answers 404 NOT_FOUND for a malformed token without reading the database', async () => {
    const { status, body } = await parseJsonResponse<ErrorBody>(await basket(createMockRequest('/api/betala/short'), tokenParams('short')))
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(db.supabase.from).not.toHaveBeenCalled()
  })

  it('answers 404 for an unknown token, looked up by its hash', async () => {
    const token = freshToken()
    db.setTable('payment_signing_links', { data: null })
    const { status } = await parseJsonResponse<ErrorBody>(await start(post(`/api/betala/${token}/signing`, { method: 'qr', personal_number: PN }), tokenParams(token)))
    expect(status).toBe(404)
    expect(db.findCall('payment_signing_links', 'eq')).toEqual(['token_hash', hashInviteToken(token)])
    expect(signing.startPaymentSigning).not.toHaveBeenCalled()
  })

  it('answers 404 for an expired and a cancelled link', async () => {
    const token = freshToken()
    db.setTable('payment_signing_links', { data: link({ expires_at: new Date(Date.now() - 1000).toISOString() }) })
    expect((await basket(createMockRequest(`/api/betala/${token}`), tokenParams(token))).status).toBe(404)
    db.setTable('payment_signing_links', { data: link({ cancelled_at: new Date().toISOString() }) })
    expect((await basket(createMockRequest(`/api/betala/${token}`), tokenParams(token))).status).toBe(404)
  })

  it('answers 404 for a consumed link on start and restart, but keeps the basket and the poll open for an hour', async () => {
    const token = freshToken()
    db.setTable('payment_signing_links', { data: link({ batch_id: BATCH, consumed_at: new Date(Date.now() - 60_000).toISOString() }) })
    expect((await start(post(`/api/betala/${token}/signing`, { method: 'qr', personal_number: PN }), tokenParams(token))).status).toBe(404)
    expect((await restart(post(`/api/betala/${token}/signing/${BATCH}/restart`, { method: 'qr', personal_number: PN }), idParams(token, BATCH))).status).toBe(404)
    expect((await basket(createMockRequest(`/api/betala/${token}`), tokenParams(token))).status).toBe(200)
    expect((await poll(post(`/api/betala/${token}/signing/${BATCH}/poll`, { personal_number: PN }), idParams(token, BATCH))).status).toBe(200)

    db.setTable('payment_signing_links', { data: link({ batch_id: BATCH, consumed_at: new Date(Date.now() - 2 * HOUR).toISOString() }) })
    expect((await poll(post(`/api/betala/${token}/signing/${BATCH}/poll`, { personal_number: PN }), idParams(token, BATCH))).status).toBe(404)
  })

  it('answers 429 RATE_LIMITED past 60 requests per token in ten minutes; the poll has its own budget', async () => {
    const token = freshToken()
    db.setTable('payment_signing_links', { data: link({ batch_id: BATCH }) })
    for (let i = 0; i < 60; i++) expect((await basket(createMockRequest(`/api/betala/${token}`), tokenParams(token))).status).toBe(200)
    const { status, body } = await parseJsonResponse<ErrorBody>(await basket(createMockRequest(`/api/betala/${token}`), tokenParams(token)))
    expect(status).toBe(429)
    expect(body.error.code).toBe('RATE_LIMITED')
    expect((await poll(post(`/api/betala/${token}/signing/${BATCH}/poll`, { personal_number: PN }), idParams(token, BATCH))).status).toBe(200)
  })
})

describe('GET /api/betala/:token', () => {
  it('answers the basket: who asked, each payment, the account paying, the total and the state', async () => {
    const token = freshToken()
    db.setTable('payment_signing_links', { data: link() })
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await basket(createMockRequest(`/api/betala/${token}`), tokenParams(token)))
    expect(status).toBe(200)
    expect(body.data).toMatchObject({
      state: 'ready',
      company_name: 'Bolaget AB',
      requester: 'Karin Byråsson',
      note: 'Oktober',
      bank_name: 'SEB',
      account: { name: 'Företagskonto', iban: 'SE35 **** 0003' },
      order_count: 2,
      total_amount: 1475,
      currency: 'SEK',
      signing: null,
    })
    expect(body.data.orders).toHaveLength(2)
    expect(JSON.stringify(body)).not.toContain(token)
  })
})

describe('POST /api/betala/:token/signing', () => {
  it('requires the typed personnummer and a known method', async () => {
    const token = freshToken()
    db.setTable('payment_signing_links', { data: link() })
    const missing = await parseJsonResponse<ErrorBody>(await start(post(`/api/betala/${token}/signing`, { method: 'qr' }), tokenParams(token)))
    expect(missing.status).toBe(400)
    expect(missing.body.error.code).toBe('PAYMENT_SIGNER_PERSONAL_NUMBER_REQUIRED')
    const blank = await parseJsonResponse<ErrorBody>(await start(post(`/api/betala/${token}/signing`, { method: 'qr', personal_number: '   ' }), tokenParams(token)))
    expect(blank.body.error.code).toBe('PAYMENT_SIGNER_PERSONAL_NUMBER_REQUIRED')
    expect((await start(post(`/api/betala/${token}/signing`, { method: 'sms', personal_number: PN }), tokenParams(token))).status).toBe(400)
    expect(signing.startPaymentSigning).not.toHaveBeenCalled()
  })

  it('signs the link\'s orders as the sender, with the typed number and never the sender\'s, and comes back to the link', async () => {
    const token = freshToken()
    db.setTable('payment_signing_links', [{ data: link() }, { data: null }])
    const { status, body } = await parseJsonResponse<{ data: { batch_id: string } }>(
      await start(post(`/api/betala/${token}/signing`, { method: 'redirect', personal_number: ` ${PN} `, order_ids: ['99999999-9999-4999-8999-999999999999'] }), tokenParams(token)),
    )
    expect(status).toBe(200)
    expect(body.data.batch_id).toBe(BATCH)
    const [op, input] = signing.startPaymentSigning.mock.calls[0]!
    expect(op).toMatchObject({ companyId: COMPANY, userId: SENDER })
    expect(input).toEqual({
      orderIds: [O1, O2],
      method: 'redirect',
      signer: { personalNumber: PN, ipAddress: '203.0.113.9', userAgent: 'Browser/1.0', lookupOnFile: false },
      returnOrigin: 'https://app.accounted.se',
      returnPath: `/betala/${token}`,
    })
    // The link remembers its signing, so a reopened link resumes it.
    expect(db.payloads('payment_signing_links', 'update')).toEqual([{ batch_id: BATCH }])
  })

  it('signs nothing when an order left approved since the link was made', async () => {
    const token = freshToken()
    db.setTable('payment_signing_links', { data: link() })
    db.setTable('payment_orders', { data: [orderRow(O1), orderRow(O2, { status: 'cancelled' })] })
    const { status, body } = await parseJsonResponse<ErrorBody>(await start(post(`/api/betala/${token}/signing`, { method: 'qr', personal_number: PN }), tokenParams(token)))
    expect(status).toBe(409)
    expect(body.error.code).toBe('PAYMENT_SIGNING_LINK_ORDERS_CHANGED')
    expect(signing.startPaymentSigning).not.toHaveBeenCalled()
  })

  it('passes a refusal of the signing service through in its own envelope', async () => {
    const token = freshToken()
    db.setTable('payment_signing_links', { data: link() })
    signing.startPaymentSigning.mockResolvedValue({ ok: false, code: 'PAYMENT_COMPANY_VERIFICATION_REQUIRED' })
    const { status, body } = await parseJsonResponse<ErrorBody>(await start(post(`/api/betala/${token}/signing`, { method: 'qr', personal_number: PN }), tokenParams(token)))
    expect(status).toBe(409)
    expect(body.error.code).toBe('PAYMENT_COMPANY_VERIFICATION_REQUIRED')
    expect(db.payloads('payment_signing_links', 'update')).toEqual([])
  })
})

describe('POST /api/betala/:token/signing/:id/poll', () => {
  it('answers 404 for a signing that is not the link\'s', async () => {
    const token = freshToken()
    db.setTable('payment_signing_links', { data: link({ batch_id: BATCH }) })
    db.setTable('payment_orders', { data: [{ id: O1 }, { id: '99999999-9999-4999-8999-999999999999' }] })
    expect((await poll(post(`/api/betala/${token}/signing/${OTHER_BATCH}/poll`, { personal_number: PN }), idParams(token, OTHER_BATCH))).status).toBe(404)
    expect((await poll(post(`/api/betala/${token}/signing/not-a-uuid/poll`, { personal_number: PN }), idParams(token, 'not-a-uuid'))).status).toBe(404)
    expect(signing.pollPaymentSigning).not.toHaveBeenCalled()
  })

  it('requires the typed personnummer', async () => {
    const token = freshToken()
    db.setTable('payment_signing_links', { data: link({ batch_id: BATCH }) })
    const { status, body } = await parseJsonResponse<ErrorBody>(await poll(post(`/api/betala/${token}/signing/${BATCH}/poll`, {}), idParams(token, BATCH)))
    expect(status).toBe(400)
    expect(body.error.code).toBe('PAYMENT_SIGNER_PERSONAL_NUMBER_REQUIRED')
    expect(signing.pollPaymentSigning).not.toHaveBeenCalled()
  })

  it('polls as the sender with the typed number, and consumes the link once the signing finalised', async () => {
    const token = freshToken()
    db.setTable('payment_signing_links', [{ data: link({ batch_id: BATCH }) }, { data: null }])
    expect((await poll(post(`/api/betala/${token}/signing/${BATCH}/poll`, { personal_number: PN }), idParams(token, BATCH))).status).toBe(200)
    expect(signing.pollPaymentSigning).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY, userId: SENDER }), {
      batchId: BATCH,
      signer: { personalNumber: PN, ipAddress: '203.0.113.9', userAgent: 'Browser/1.0', lookupOnFile: false },
    })
    expect(db.payloads('payment_signing_links', 'update')).toEqual([])

    signing.pollPaymentSigning.mockResolvedValue({ ok: true, data: view('signed') })
    db.setTable('payment_signing_links', [{ data: link({ batch_id: BATCH }) }, { data: null }])
    expect((await poll(post(`/api/betala/${token}/signing/${BATCH}/poll`, { personal_number: PN }), idParams(token, BATCH))).status).toBe(200)
    expect(db.payloads('payment_signing_links', 'update')).toEqual([{ consumed_at: expect.any(String) }])
  })

  it('also consumes it when the bank waits for a second signer', async () => {
    const token = freshToken()
    db.setTable('payment_signing_links', [{ data: link({ batch_id: BATCH }) }, { data: null }])
    signing.pollPaymentSigning.mockResolvedValue({ ok: true, data: view('awaiting_second_signer') })
    await poll(post(`/api/betala/${token}/signing/${BATCH}/poll`, { personal_number: PN }), idParams(token, BATCH))
    expect(db.payloads('payment_signing_links', 'update')).toEqual([{ consumed_at: expect.any(String) }])
  })
})

describe('POST /api/betala/:token/signing/:id/restart', () => {
  it('signs the link\'s signing again with the typed number, and follows it to a new batch', async () => {
    const token = freshToken()
    db.setTable('payment_signing_links', [{ data: link({ batch_id: BATCH }) }, { data: null }])
    signing.restartPaymentSigning.mockResolvedValue({ ok: true, data: view('awaiting_signature', NEW_BATCH) })
    const response = await restart(post(`/api/betala/${token}/signing/${BATCH}/restart`, { method: 'qr', personal_number: PN }), idParams(token, BATCH))
    expect(response.status).toBe(200)
    expect(signing.restartPaymentSigning).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY, userId: SENDER }), {
      batchId: BATCH,
      method: 'qr',
      signer: { personalNumber: PN, ipAddress: '203.0.113.9', userAgent: 'Browser/1.0', lookupOnFile: false },
      returnOrigin: 'https://app.accounted.se',
      returnPath: `/betala/${token}`,
    })
    expect(db.payloads('payment_signing_links', 'update')).toEqual([{ batch_id: NEW_BATCH }])
  })

  it('requires the personnummer and the link\'s own signing', async () => {
    const token = freshToken()
    db.setTable('payment_signing_links', { data: link({ batch_id: BATCH }) })
    const missing = await parseJsonResponse<ErrorBody>(await restart(post(`/api/betala/${token}/signing/${BATCH}/restart`, { method: 'qr' }), idParams(token, BATCH)))
    expect(missing.body.error.code).toBe('PAYMENT_SIGNER_PERSONAL_NUMBER_REQUIRED')
    db.setTable('payment_orders', { data: [] })
    expect((await restart(post(`/api/betala/${token}/signing/${OTHER_BATCH}/restart`, { method: 'qr', personal_number: PN }), idParams(token, OTHER_BATCH))).status).toBe(404)
    expect(signing.restartPaymentSigning).not.toHaveBeenCalled()
  })
})

describe('the Nordea Corporate Netbank logon id on the signing link', () => {
  it('carries the firmatecknare\'s typed logon id on the start, the restart and the poll, and no key without one', async () => {
    const token = freshToken()
    db.setTable('payment_signing_links', [{ data: link() }, { data: null }])
    await start(post(`/api/betala/${token}/signing`, { method: 'redirect', personal_number: PN, psu_authoriser_id: ' corp-user-1 ' }), tokenParams(token))
    expect(signing.startPaymentSigning.mock.lastCall?.[1].signer).toEqual({ personalNumber: PN, ipAddress: '203.0.113.9', userAgent: 'Browser/1.0', psuAuthoriserId: 'corp-user-1', lookupOnFile: false })

    db.setTable('payment_signing_links', [{ data: link({ batch_id: BATCH }) }, { data: null }])
    await restart(post(`/api/betala/${token}/signing/${BATCH}/restart`, { method: 'qr', personal_number: PN, psu_authoriser_id: 'corp-user-1' }), idParams(token, BATCH))
    expect(signing.restartPaymentSigning.mock.lastCall?.[1].signer).toMatchObject({ psuAuthoriserId: 'corp-user-1' })

    db.setTable('payment_signing_links', [{ data: link({ batch_id: BATCH }) }, { data: null }])
    await poll(post(`/api/betala/${token}/signing/${BATCH}/poll`, { personal_number: PN, psu_authoriser_id: 'corp-user-1' }), idParams(token, BATCH))
    expect(signing.pollPaymentSigning.mock.lastCall?.[1].signer).toMatchObject({ psuAuthoriserId: 'corp-user-1' })

    db.setTable('payment_signing_links', [{ data: link({ batch_id: BATCH }) }, { data: null }])
    await poll(post(`/api/betala/${token}/signing/${BATCH}/poll`, { personal_number: PN }), idParams(token, BATCH))
    expect(signing.pollPaymentSigning.mock.lastCall?.[1].signer).not.toHaveProperty('psuAuthoriserId')
  })

  it('answers 400 for a logon id that is not text', async () => {
    const token = freshToken()
    db.setTable('payment_signing_links', { data: link() })
    expect((await start(post(`/api/betala/${token}/signing`, { method: 'qr', personal_number: PN, psu_authoriser_id: 42 }), tokenParams(token))).status).toBe(400)
    expect(signing.startPaymentSigning).not.toHaveBeenCalled()
  })
})
