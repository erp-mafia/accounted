import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/has-capability')>()),
  hasCapability: vi.fn().mockResolvedValue(true),
  requireCapability: vi.fn().mockResolvedValue(null),
}))
import { createMockRequest, createTableMockSupabase, parseJsonResponse } from '@/tests/helpers'
import { hashInviteToken } from '@/lib/bank-feed/invites'

const db = createTableMockSupabase()
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => db.supabase }))

vi.mock('@/lib/bank-feed/request-return', () => ({ returnOriginFor: vi.fn().mockResolvedValue('https://app.accounted.se') }))

const service = vi.hoisted(() => ({
  listBankFeedBanks: vi.fn(),
  getBankFeedBankDetails: vi.fn(),
  getBankFeedConnection: vi.fn(),
  startBankFeedConsent: vi.fn(),
  pollBankFeedConsent: vi.fn(),
  restartBankFeedConsent: vi.fn(),
  selectBankFeedAccounts: vi.fn(),
  syncBankFeedConnection: vi.fn(),
  disconnectBankFeedConnection: vi.fn(),
}))
vi.mock('@/lib/bank-feed/service', () => service)
const payments = vi.hoisted(() => ({
  getCompanyPaymentVerification: vi.fn(),
  startCompanyPaymentVerification: vi.fn(),
}))
vi.mock('@/lib/payments/orders/availability', () => payments)

import { GET as banks } from '../[token]/banks/route'
import { GET as bankDetails } from '../[token]/banks/[bic]/route'
import { POST as start } from '../[token]/connections/route'
import { DELETE as abandon, GET as connection } from '../[token]/connections/[id]/route'
import { POST as poll } from '../[token]/connections/[id]/poll/route'
import { POST as restart } from '../[token]/connections/[id]/restart/route'
import { POST as select } from '../[token]/connections/[id]/select/route'
import { POST as sync } from '../[token]/connections/[id]/sync/route'
import { GET as verification } from '../[token]/verification/route'
import { POST as verificationStart } from '../[token]/verification/start/route'

const ID = '11111111-1111-4111-8111-111111111111'
const INVITE_ID = '22222222-2222-4222-8222-222222222222'
const COMPANY = '33333333-3333-4333-8333-333333333333'
const SENDER = '44444444-4444-4444-8444-444444444444'
const DAY = 24 * 60 * 60 * 1000

/** A distinct valid token per test, so the process-local limiter never carries over. */
let tokenCounter = 0
function freshToken(): string {
  tokenCounter += 1
  return `${String(tokenCounter).padStart(6, '0')}${'x'.repeat(37)}`
}

function invite(overrides: Record<string, unknown> = {}) {
  return {
    id: INVITE_ID,
    company_id: COMPANY,
    created_by: SENDER,
    bic: null,
    replace_connection_id: null,
    offer_payments: true,
    recipient_email: null,
    mail_sent_at: null,
    expires_at: new Date(Date.now() + 7 * DAY).toISOString(),
    consumed_at: null,
    connection_id: null,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

const tokenParams = (token: string) => ({ params: Promise.resolve({ token }) })
const idParams = (token: string, id: string) => ({ params: Promise.resolve({ token, id }) })
const bicParams = (token: string, bic: string) => ({ params: Promise.resolve({ token, bic }) })
const post = (url: string, body?: unknown) =>
  createMockRequest(url, { method: 'POST', ...(body === undefined ? {} : { body }), headers: { 'x-forwarded-for': '203.0.113.9', 'user-agent': 'Browser/1.0' } })

type ErrorBody = { error: { code: string; message: string } }

beforeEach(() => {
  vi.clearAllMocks()
  db.reset()
  for (const fn of Object.values(service)) fn.mockResolvedValue({ ok: true, data: { ok: 'yes' } })
  for (const fn of Object.values(payments)) fn.mockResolvedValue({ ok: true, data: { status: 'invalid', valid_until: null } })
})

describe('the signatory token routes refuse what is not a live link', () => {
  it('answers 404 NOT_FOUND for a malformed token without reading the database', async () => {
    const { status, body } = await parseJsonResponse<ErrorBody>(await banks(createMockRequest('/api/koppla/short/banks'), tokenParams('short')))
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(db.supabase.from).not.toHaveBeenCalled()
    expect(service.listBankFeedBanks).not.toHaveBeenCalled()
  })

  it('answers 404 for an unknown token and looks it up by hash, never by the clear token', async () => {
    const token = freshToken()
    db.setTable('bank_connect_invites', { data: null })
    const { status, body } = await parseJsonResponse<ErrorBody>(await banks(createMockRequest(`/api/koppla/${token}/banks`), tokenParams(token)))
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(db.findCall('bank_connect_invites', 'eq')).toEqual(['token_hash', hashInviteToken(token)])
    expect(service.listBankFeedBanks).not.toHaveBeenCalled()
  })

  it('answers 404 for an expired token', async () => {
    const token = freshToken()
    db.setTable('bank_connect_invites', { data: invite({ expires_at: new Date(Date.now() - 1000).toISOString() }) })
    expect((await banks(createMockRequest(`/api/koppla/${token}/banks`), tokenParams(token))).status).toBe(404)
    expect(service.listBankFeedBanks).not.toHaveBeenCalled()
  })

  it('answers 404 for a consumed token on the opening routes, but keeps the follow-up routes open for two hours', async () => {
    const token = freshToken()
    db.setTable('bank_connect_invites', { data: invite({ consumed_at: new Date(Date.now() - 60_000).toISOString(), connection_id: ID }) })
    expect((await start(post(`/api/koppla/${token}/connections`, { bic: 'SWEDSESS', method: 'qr', personal_number: '199001011239' }), tokenParams(token))).status).toBe(404)
    expect((await select(post(`/api/koppla/${token}/connections/${ID}/select`, { accounts: [{ uid: 'A', enabled: true }] }), idParams(token, ID))).status).toBe(404)
    expect(service.startBankFeedConsent).not.toHaveBeenCalled()
    expect(service.selectBankFeedAccounts).not.toHaveBeenCalled()

    expect((await poll(post(`/api/koppla/${token}/connections/${ID}/poll`, { personal_number: '199001011239' }), idParams(token, ID))).status).toBe(200)
    expect((await sync(post(`/api/koppla/${token}/connections/${ID}/sync`, { personal_number: '199001011239' }), idParams(token, ID))).status).toBe(200)
    expect((await verification(createMockRequest(`/api/koppla/${token}/verification`), tokenParams(token))).status).toBe(200)

    db.setTable('bank_connect_invites', { data: invite({ consumed_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(), connection_id: ID }) })
    expect((await poll(post(`/api/koppla/${token}/connections/${ID}/poll`), idParams(token, ID))).status).toBe(404)
  })

  it('answers 429 RATE_LIMITED past 60 requests per token in ten minutes', async () => {
    const token = freshToken()
    db.setTable('bank_connect_invites', { data: invite() })
    for (let i = 0; i < 60; i++) expect((await banks(createMockRequest(`/api/koppla/${token}/banks`), tokenParams(token))).status).toBe(200)
    const { status, body } = await parseJsonResponse<ErrorBody>(await banks(createMockRequest(`/api/koppla/${token}/banks`), tokenParams(token)))
    expect(status).toBe(429)
    expect(body.error.code).toBe('RATE_LIMITED')
    // The consent poll has its own budget: the general limit does not starve it.
    expect((await poll(post(`/api/koppla/${token}/connections/${ID}/poll`, { personal_number: '199001011239' }), idParams(token, ID))).status).toBe(200)
  })
})

describe('the signatory token routes act as the sender for the company the link names', () => {
  it('GET banks delegates with the link\'s company and sender', async () => {
    const token = freshToken()
    db.setTable('bank_connect_invites', { data: invite() })
    service.listBankFeedBanks.mockResolvedValue({ ok: true, data: { banks: [{ bic: 'SWEDSESS', name: 'Swedbank', logo_url: null, decoupled: true, redirect: null }] } })
    const { status, body } = await parseJsonResponse<{ data: { banks: unknown[] } }>(await banks(createMockRequest(`/api/koppla/${token}/banks`), tokenParams(token)))
    expect(status).toBe(200)
    expect(body.data.banks).toHaveLength(1)
    expect(service.listBankFeedBanks).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY, userId: SENDER }))
  })

  it('GET banks answers 403 OPEN_BANKING_NOT_AVAILABLE when the door is closed for the company', async () => {
    const token = freshToken()
    db.setTable('bank_connect_invites', { data: invite() })
    service.listBankFeedBanks.mockResolvedValue({ ok: false, code: 'OPEN_BANKING_NOT_AVAILABLE', details: { reason: 'not_in_pilot' } })
    const { status, body } = await parseJsonResponse<ErrorBody>(await banks(createMockRequest(`/api/koppla/${token}/banks`), tokenParams(token)))
    expect(status).toBe(403)
    expect(body.error.code).toBe('OPEN_BANKING_NOT_AVAILABLE')
  })

  it('POST connections requires the typed personnummer and passes the signer\'s IP and user agent', async () => {
    const token = freshToken()
    db.setTable('bank_connect_invites', { data: invite() })
    expect((await start(post(`/api/koppla/${token}/connections`, { bic: 'SWEDSESS', method: 'qr' }), tokenParams(token))).status).toBe(400)
    expect(service.startBankFeedConsent).not.toHaveBeenCalled()

    service.startBankFeedConsent.mockResolvedValue({ ok: true, data: { connection_id: ID, attempt: { authorisation_id: 'a', method: 'qr', state: 'pending', challenge: null, sca_status: null, step: null, failure_code: null, failure_text: null } } })
    const { status, body } = await parseJsonResponse<{ data: { connection_id: string } }>(
      await start(post(`/api/koppla/${token}/connections`, { bic: 'SWEDSESS', method: 'qr', personal_number: '19900101-1239', account_context: 'private' }), tokenParams(token)),
    )
    expect(status).toBe(200)
    expect(body.data.connection_id).toBe(ID)
    // The return page is always this link: a bank that signs on its own page comes back to /koppla/<token>.
    expect(service.startBankFeedConsent).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY, userId: SENDER }), {
      bic: 'SWEDSESS',
      method: 'qr',
      affiliatedAspspId: null,
      accountContext: 'private',
      replaceConnectionId: null,
      returnTo: 'koppla',
      returnOrigin: 'https://app.accounted.se',
      returnToken: token,
      signer: { personalNumber: '19900101-1239', ipAddress: '203.0.113.9', userAgent: 'Browser/1.0', lookupOnFile: false },
    })
  })

  it('POST connections holds the firmatecknare to the bank the link names and passes the link\'s connection to replace straight through', async () => {
    const token = freshToken()
    db.setTable('bank_connect_invites', { data: invite({ bic: 'SWEDSESS', replace_connection_id: ID }) })
    const refused = await parseJsonResponse<ErrorBody>(await start(post(`/api/koppla/${token}/connections`, { bic: 'NDEASESS', method: 'qr', personal_number: '199001011239' }), tokenParams(token)))
    expect(refused.status).toBe(400)
    expect(refused.body.error.code).toBe('VALIDATION_ERROR')
    expect(service.startBankFeedConsent).not.toHaveBeenCalled()

    // A switch (an Enable Banking row) or a renewal (an Open Payments row): the service tells them apart.
    await start(post(`/api/koppla/${token}/connections`, { bic: 'SWEDSESS', method: 'redirect', personal_number: '199001011239' }), tokenParams(token))
    expect(service.startBankFeedConsent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ bic: 'SWEDSESS', method: 'redirect', replaceConnectionId: ID }))
    // The body never names the return page; a row the link does not name is never touched.
    expect(db.supabase.from).not.toHaveBeenCalledWith('bank_connections')
  })

  it('GET banks/:bic answers the bank\'s details for the firmatecknare\'s flow', async () => {
    const token = freshToken()
    db.setTable('bank_connect_invites', { data: invite() })
    service.getBankFeedBankDetails.mockResolvedValue({ ok: true, data: { bic: 'SWEDSESS', name: 'Swedbank', decoupled: true, redirect: true, affiliates: [{ id: '08999', name: 'Sparbanken Nord' }], transaction_history_max_days: 90, extended_transaction_history_max_days: 730 } })
    const { status, body } = await parseJsonResponse<{ data: { affiliates: unknown[] } }>(await bankDetails(createMockRequest(`/api/koppla/${token}/banks/swedsess`), bicParams(token, 'swedsess')))
    expect(status).toBe(200)
    expect(body.data.affiliates).toHaveLength(1)
    expect(service.getBankFeedBankDetails).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY }), 'SWEDSESS')
    expect((await bankDetails(createMockRequest(`/api/koppla/${token}/banks/nope`), bicParams(token, 'nope'))).status).toBe(400)
  })

  it('POST poll, restart and sync mirror the session routes, require the typed personnummer and never look the sender\'s up, with a 404 for a malformed connection id', async () => {
    const token = freshToken()
    db.setTable('bank_connect_invites', { data: invite() })
    expect((await poll(post(`/api/koppla/${token}/connections/nope/poll`), idParams(token, 'nope'))).status).toBe(404)
    // Without a typed number the call names nobody: refused before the service, never the sender's number on file.
    const bare = await poll(post(`/api/koppla/${token}/connections/${ID}/poll`), idParams(token, ID))
    expect(bare.status).toBe(400)
    expect(((await bare.json()) as ErrorBody).error.code).toBe('BANK_CONSENT_PERSONAL_NUMBER_REQUIRED')
    expect(service.pollBankFeedConsent).not.toHaveBeenCalled()
    await poll(post(`/api/koppla/${token}/connections/${ID}/poll`, { personal_number: '199001011239' }), idParams(token, ID))
    expect(service.pollBankFeedConsent).toHaveBeenLastCalledWith(expect.objectContaining({ companyId: COMPANY }), {
      connectionId: ID,
      signer: { personalNumber: '199001011239', ipAddress: '203.0.113.9', userAgent: 'Browser/1.0', lookupOnFile: false },
    })
    expect((await restart(post(`/api/koppla/${token}/connections/${ID}/restart`, { method: 'same_device' }), idParams(token, ID))).status).toBe(400)
    await restart(post(`/api/koppla/${token}/connections/${ID}/restart`, { method: 'same_device', personal_number: '199001011239' }), idParams(token, ID))
    expect(service.restartBankFeedConsent).toHaveBeenCalledWith(expect.anything(), {
      connectionId: ID,
      method: 'same_device',
      returnTo: 'koppla',
      returnOrigin: 'https://app.accounted.se',
      returnToken: token,
      signer: expect.objectContaining({ personalNumber: '199001011239', lookupOnFile: false }),
    })
    expect((await sync(post(`/api/koppla/${token}/connections/${ID}/sync`), idParams(token, ID))).status).toBe(400)
    await sync(post(`/api/koppla/${token}/connections/${ID}/sync`, { personal_number: '199001011239' }), idParams(token, ID))
    expect(service.syncBankFeedConnection).toHaveBeenCalledWith(expect.anything(), { connectionId: ID, signer: expect.objectContaining({ ipAddress: '203.0.113.9', lookupOnFile: false }) })
    await connection(createMockRequest(`/api/koppla/${token}/connections/${ID}`), idParams(token, ID))
    expect(service.getBankFeedConnection).toHaveBeenCalledWith(expect.anything(), ID)
  })

  it('POST select saves the selection and marks the link consumed with the connection', async () => {
    const token = freshToken()
    db.setTable('bank_connect_invites', { data: invite() })
    service.selectBankFeedAccounts.mockResolvedValue({ ok: true, data: { connection: { connection_id: ID }, sync: { imported: 3, duplicates: 0, from: '2026-01-01', to: '2026-10-12' }, sync_pending: false } })
    const { status, body } = await parseJsonResponse<{ data: { sync: { imported: number } } }>(
      await select(post(`/api/koppla/${token}/connections/${ID}/select`, { accounts: [{ uid: 'A', enabled: true, ledger_account: '1930' }], personal_number: '199001011239' }), idParams(token, ID)),
    )
    expect(status).toBe(200)
    expect(body.data.sync.imported).toBe(3)
    expect(service.selectBankFeedAccounts).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY, userId: SENDER }),
      expect.objectContaining({ connectionId: ID, accounts: [{ uid: 'A', enabled: true, ledgerAccount: '1930' }], signer: expect.objectContaining({ personalNumber: '199001011239' }) }),
    )
    const consumed = db.payloads('bank_connect_invites', 'update')[0] as { consumed_at: string; connection_id: string }
    expect(consumed.connection_id).toBe(ID)
    expect(typeof consumed.consumed_at).toBe('string')
  })

  it('POST select leaves the link open when the service refuses', async () => {
    const token = freshToken()
    db.setTable('bank_connect_invites', { data: invite() })
    service.selectBankFeedAccounts.mockResolvedValue({ ok: false, code: 'BANK_CONSENT_NOT_READY' })
    const { status } = await parseJsonResponse<ErrorBody>(await select(post(`/api/koppla/${token}/connections/${ID}/select`, { accounts: [{ uid: 'A', enabled: true }] }), idParams(token, ID)))
    expect(status).toBeGreaterThanOrEqual(400)
    expect(db.payloads('bank_connect_invites', 'update')).toEqual([])
  })

  it('DELETE removes only a half-made attempt, never a live connection', async () => {
    const token = freshToken()
    db.setTable('bank_connect_invites', { data: invite() })
    db.setTable('bank_connections', { data: { id: ID, status: 'active' } })
    expect((await abandon(createMockRequest(`/api/koppla/${token}/connections/${ID}`, { method: 'DELETE' }), idParams(token, ID))).status).toBe(404)
    expect(service.disconnectBankFeedConnection).not.toHaveBeenCalled()
    db.setTable('bank_connections', { data: { id: ID, status: 'pending' } })
    expect((await abandon(createMockRequest(`/api/koppla/${token}/connections/${ID}`, { method: 'DELETE' }), idParams(token, ID))).status).toBe(200)
    expect(service.disconnectBankFeedConnection).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY }), ID)
  })

  it('the verification routes answer only for a link that offers payments', async () => {
    const token = freshToken()
    db.setTable('bank_connect_invites', { data: invite({ offer_payments: false }) })
    const { status, body } = await parseJsonResponse<ErrorBody>(await verification(createMockRequest(`/api/koppla/${token}/verification`), tokenParams(token)))
    expect(status).toBe(403)
    expect(body.error.code).toBe('PAYMENTS_UNAVAILABLE')
    expect(payments.getCompanyPaymentVerification).not.toHaveBeenCalled()

    db.setTable('bank_connect_invites', { data: invite({ offer_payments: true }) })
    payments.startCompanyPaymentVerification.mockResolvedValue({ ok: true, data: { url: 'https://verify.example/form' } })
    const started = await parseJsonResponse<{ data: { url: string } }>(await verificationStart(post(`/api/koppla/${token}/verification/start`), tokenParams(token)))
    expect(started.status).toBe(200)
    expect(started.body.data.url).toBe('https://verify.example/form')
    expect(payments.startCompanyPaymentVerification).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY, userId: SENDER }))
  })

  it('the verification status asks the provider again only when the page polls with refresh', async () => {
    const token = freshToken()
    db.setTable('bank_connect_invites', { data: invite({ offer_payments: true }) })
    payments.getCompanyPaymentVerification.mockResolvedValue({ ok: true, data: { status: 'invalid', valid_until: null, state: 'form_open', link_expires_at: '2026-10-15T09:00:00.000Z', checked_at: null } })
    await verification(createMockRequest(`/api/koppla/${token}/verification`), tokenParams(token))
    expect(payments.getCompanyPaymentVerification).toHaveBeenLastCalledWith(expect.objectContaining({ companyId: COMPANY }), { refresh: false })
    const polled = await parseJsonResponse<{ data: { state: string } }>(await verification(createMockRequest(`/api/koppla/${token}/verification?refresh=1`), tokenParams(token)))
    expect(polled.body.data.state).toBe('form_open')
    expect(payments.getCompanyPaymentVerification).toHaveBeenLastCalledWith(expect.anything(), { refresh: true })
  })
})
