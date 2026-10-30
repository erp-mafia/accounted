import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/has-capability')>()),
  hasCapability: vi.fn().mockResolvedValue(true),
  requireCapability: vi.fn().mockResolvedValue(null),
}))
import { createCronRequest, createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
  createServiceClient: () => mockSupabase,
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
// The origin a redirect comes back to is resolved against the brands registry; here the request host is trusted as is.
vi.mock('@/lib/domains/trusted-app-origin', () => ({
  requestHost: (request: Request) => request.headers.get('host'),
  resolveTrustedAppOrigin: vi.fn(async (host: string | null) => `https://${host ?? 'app.accounted.se'}`),
}))

const service = vi.hoisted(() => ({
  listBankFeedBanks: vi.fn(),
  getBankFeedBankDetails: vi.fn(),
  getBankFeedOverview: vi.fn(),
  getBankFeedConnection: vi.fn(),
  startBankFeedConsent: vi.fn(),
  pollBankFeedConsent: vi.fn(),
  restartBankFeedConsent: vi.fn(),
  selectBankFeedAccounts: vi.fn(),
  syncBankFeedConnection: vi.fn(),
  disconnectBankFeedConnection: vi.fn(),
}))
vi.mock('@/lib/bank-feed/service', () => service)
const cron = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('@/lib/bank-feed/cron', () => ({ runOpenPaymentsCron: (...a: unknown[]) => cron.run(...a) }))
vi.mock('@/lib/supabase/service-client', () => ({ createServiceRoleClient: () => ({}) }))

import { GET as banks } from '../banks/route'
import { GET as bank } from '../banks/[bic]/route'
import { GET as overview, POST as start } from '../connections/route'
import { POST as poll } from '../connections/[id]/poll/route'
import { POST as restart } from '../connections/[id]/restart/route'
import { POST as select, maxDuration as selectMaxDuration } from '../connections/[id]/select/route'
import { POST as sync } from '../connections/[id]/sync/route'
import { DELETE as disconnect, GET as connection } from '../connections/[id]/route'
import { GET as cronRoute } from '../sync/cron/route'

const ID = '11111111-1111-4111-8111-111111111111'
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const none = { params: Promise.resolve({}) }
const post = (url: string, body?: unknown, headers: Record<string, string> = {}) =>
  createMockRequest(url, { method: 'POST', ...(body === undefined ? {} : { body }), headers: { 'x-forwarded-for': '203.0.113.9', 'user-agent': 'Browser/1.0', host: 'app.accounted.se', ...headers } })

type ErrorBody = { error: { code: string; message: string; message_en?: string } }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
  for (const fn of Object.values(service)) fn.mockResolvedValue({ ok: true, data: { ok: 'yes' } })
})
afterEach(() => vi.unstubAllEnvs())

describe('open payments routes without a session', () => {
  it.each([
    ['GET banks', () => banks(createMockRequest('/api/bank/open-payments/banks'), none)],
    ['GET bank', () => bank(createMockRequest('/api/bank/open-payments/banks/SWEDSESS'), { params: Promise.resolve({ bic: 'SWEDSESS' }) })],
    ['GET connections', () => overview(createMockRequest('/api/bank/open-payments/connections'), none)],
    ['POST connections', () => start(post('/api/bank/open-payments/connections', { bic: 'SWEDSESS', method: 'qr' }), none)],
    ['POST poll', () => poll(post(`/api/bank/open-payments/connections/${ID}/poll`), params(ID))],
    ['POST restart', () => restart(post(`/api/bank/open-payments/connections/${ID}/restart`), params(ID))],
    ['POST select', () => select(post(`/api/bank/open-payments/connections/${ID}/select`, { accounts: [{ uid: 'A', enabled: true }] }), params(ID))],
    ['POST sync', () => sync(post(`/api/bank/open-payments/connections/${ID}/sync`), params(ID))],
    ['GET connection', () => connection(createMockRequest(`/api/bank/open-payments/connections/${ID}`), params(ID))],
    ['DELETE connection', () => disconnect(createMockRequest(`/api/bank/open-payments/connections/${ID}`, { method: 'DELETE' }), params(ID))],
  ])('%s answers 401', async (_name, call) => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    expect((await call()).status).toBe(401)
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled()
  })
})

describe('open payments routes validate their bodies', () => {
  it('POST connections needs a BIC, a known method and a known return page', async () => {
    expect((await start(post('/api/bank/open-payments/connections', { bic: 'swed', method: 'qr' }), none)).status).toBe(400)
    expect((await start(post('/api/bank/open-payments/connections', { bic: 'SWEDSESS', method: 'popup' }), none)).status).toBe(400)
    expect((await start(post('/api/bank/open-payments/connections', { bic: 'SWEDSESS', method: 'redirect', return_to: '/evil' }), none)).status).toBe(400)
    expect((await start(post('/api/bank/open-payments/connections', { bic: 'SWEDSESS', method: 'qr', replace_connection_id: 'nope' }), none)).status).toBe(400)
    expect(service.startBankFeedConsent).not.toHaveBeenCalled()
  })

  it('GET bank refuses a malformed BIC without asking the service', async () => {
    const { status, body } = await parseJsonResponse<ErrorBody>(await bank(createMockRequest('/api/bank/open-payments/banks/swed!'), { params: Promise.resolve({ bic: 'swed!' }) }))
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(service.getBankFeedBankDetails).not.toHaveBeenCalled()
  })

  it('POST select needs accounts with a uid and a 19xx ledger, null allowed', async () => {
    expect((await select(post(`/api/bank/open-payments/connections/${ID}/select`, { accounts: [] }), params(ID))).status).toBe(400)
    expect((await select(post(`/api/bank/open-payments/connections/${ID}/select`, { accounts: [{ uid: 'A', enabled: true, ledger_account: '3001' }] }), params(ID))).status).toBe(400)
    expect(service.selectBankFeedAccounts).not.toHaveBeenCalled()
  })
})

describe('open payments routes map the service answers', () => {
  it('GET banks answers 403 OPEN_BANKING_NOT_AVAILABLE in the envelope when the door is closed', async () => {
    service.listBankFeedBanks.mockResolvedValue({ ok: false, code: 'OPEN_BANKING_NOT_AVAILABLE', details: { reason: 'not_in_pilot' } })
    const { status, body } = await parseJsonResponse<ErrorBody>(await banks(createMockRequest('/api/bank/open-payments/banks'), none))
    expect(status).toBe(403)
    expect(body.error.code).toBe('OPEN_BANKING_NOT_AVAILABLE')
    expect(body.error.message).toMatch(/inte aktiverat/)
    expect(body.error.message_en).toMatch(/not enabled/)
  })

  it('GET banks answers the list when the door is open', async () => {
    service.listBankFeedBanks.mockResolvedValue({ ok: true, data: { banks: [{ bic: 'SWEDSESS', name: 'Swedbank', logo_url: null, decoupled: true, redirect: null }] } })
    const { status, body } = await parseJsonResponse<{ data: { banks: unknown[] } }>(await banks(createMockRequest('/api/bank/open-payments/banks'), none))
    expect(status).toBe(200)
    expect(body.data.banks).toHaveLength(1)
  })

  it('GET bank answers the details for the upper-cased BIC and names an unknown bank', async () => {
    service.getBankFeedBankDetails.mockResolvedValue({ ok: true, data: { bic: 'SWEDSESS', name: 'Swedbank', decoupled: true, redirect: true, affiliates: [{ id: '08999', name: 'Sparbanken Nord' }], transaction_history_max_days: 88, extended_transaction_history_max_days: 760 } })
    const ok = await parseJsonResponse<{ data: { affiliates: unknown[] } }>(await bank(createMockRequest('/api/bank/open-payments/banks/swedsess'), { params: Promise.resolve({ bic: 'swedsess' }) }))
    expect(ok.status).toBe(200)
    expect(ok.body.data.affiliates).toHaveLength(1)
    expect(service.getBankFeedBankDetails).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1' }), 'SWEDSESS')
    service.getBankFeedBankDetails.mockResolvedValue({ ok: false, code: 'BANK_CONSENT_UNKNOWN_BANK' })
    const { status, body } = await parseJsonResponse<ErrorBody>(await bank(createMockRequest('/api/bank/open-payments/banks/XXXXSESS'), { params: Promise.resolve({ bic: 'XXXXSESS' }) }))
    expect(status).toBe(400)
    expect(body.error.code).toBe('BANK_CONSENT_UNKNOWN_BANK')
  })

  it('POST connections with the redirect method passes the return page and the origin the request came to', async () => {
    service.startBankFeedConsent.mockResolvedValue({ ok: true, data: { connection_id: ID, attempt: { authorisation_id: 'a', method: 'redirect', state: 'pending', challenge: { approach: 'redirect', autostartToken: null, qrData: null, qrImage: null, redirectUrl: 'https://bank.example/sign' }, sca_status: null, step: null, failure_code: null, failure_text: null } } })
    const { status, body } = await parseJsonResponse<{ data: { attempt: { challenge: { redirectUrl: string } } } }>(
      await start(post('/api/bank/open-payments/connections', { bic: 'SWEDSESS', method: 'redirect', return_to: 'connections' }, { host: 'brand.example.se' }), none),
    )
    expect(status).toBe(200)
    expect(body.data.attempt.challenge.redirectUrl).toBe('https://bank.example/sign')
    expect(service.startBankFeedConsent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: 'redirect', returnTo: 'connections', returnOrigin: 'https://brand.example.se' }))
    // Without a return page nothing is resolved.
    await start(post('/api/bank/open-payments/connections', { bic: 'SWEDSESS', method: 'qr' }), none)
    expect(service.startBankFeedConsent).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ method: 'qr', returnTo: null, returnOrigin: null }))
  })

  it('POST connections passes the body, the signer\'s IP and user agent, and the typed personnummer', async () => {
    service.startBankFeedConsent.mockResolvedValue({ ok: true, data: { connection_id: ID, attempt: { authorisation_id: 'a', method: 'qr', state: 'pending', challenge: null, sca_status: null, step: null, failure_code: null, failure_text: null } } })
    const { status, body } = await parseJsonResponse<{ data: { connection_id: string } }>(
      await start(post('/api/bank/open-payments/connections', { bic: 'SWEDSESS', method: 'qr', affiliated_aspsp_id: '08999', account_context: 'private', personal_number: '19900101-1239', replace_connection_id: ID }), none),
    )
    expect(status).toBe(200)
    expect(body.data.connection_id).toBe(ID)
    expect(service.startBankFeedConsent).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }), {
      bic: 'SWEDSESS', method: 'qr', affiliatedAspspId: '08999', accountContext: 'private', replaceConnectionId: ID, returnTo: null, returnOrigin: null,
      signer: { personalNumber: '19900101-1239', ipAddress: '203.0.113.9', userAgent: 'Browser/1.0' },
    })
  })

  it('POST poll works without a body, carries a typed personnummer when given, and answers 404 for a row the company does not have', async () => {
    service.pollBankFeedConsent.mockResolvedValue({ ok: false, code: 'NOT_FOUND' })
    const { status, body } = await parseJsonResponse<ErrorBody>(await poll(post(`/api/bank/open-payments/connections/${ID}/poll`), params(ID)))
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(service.pollBankFeedConsent).toHaveBeenCalledWith(expect.anything(), { connectionId: ID, signer: { personalNumber: null, ipAddress: '203.0.113.9', userAgent: 'Browser/1.0' } })
    await poll(post(`/api/bank/open-payments/connections/${ID}/poll`, { personal_number: '199001011239' }), params(ID))
    expect(service.pollBankFeedConsent).toHaveBeenLastCalledWith(expect.anything(), { connectionId: ID, signer: { personalNumber: '199001011239', ipAddress: '203.0.113.9', userAgent: 'Browser/1.0' } })
    // A malformed body is read as none.
    await poll(post(`/api/bank/open-payments/connections/${ID}/poll`, { personal_number: 42 }), params(ID))
    expect(service.pollBankFeedConsent).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ signer: expect.objectContaining({ personalNumber: null }) }))
  })

  it('POST restart works without a body, reads an optional one, and always knows the origin to come back to', async () => {
    await restart(post(`/api/bank/open-payments/connections/${ID}/restart`), params(ID))
    expect(service.restartBankFeedConsent).toHaveBeenLastCalledWith(expect.anything(), { connectionId: ID, method: null, returnTo: null, returnOrigin: 'https://app.accounted.se', signer: expect.objectContaining({ personalNumber: null }) })
    await restart(post(`/api/bank/open-payments/connections/${ID}/restart`, { method: 'same_device', personal_number: '199001011239' }), params(ID))
    expect(service.restartBankFeedConsent).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ connectionId: ID, method: 'same_device', returnTo: null, signer: expect.objectContaining({ personalNumber: '199001011239' }) }))
    await restart(post(`/api/bank/open-payments/connections/${ID}/restart`, { method: 'redirect', return_to: 'banking' }), params(ID))
    expect(service.restartBankFeedConsent).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ method: 'redirect', returnTo: 'banking', returnOrigin: 'https://app.accounted.se' }))
    // An unknown return page is read as none, like any other malformed optional body.
    await restart(post(`/api/bank/open-payments/connections/${ID}/restart`, { method: 'redirect', return_to: '/evil' }), params(ID))
    expect(service.restartBankFeedConsent).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ method: null, returnTo: null }))
  })

  it('POST connections, restart and poll carry a typed Nordea Corporate Netbank logon id to the service; 400 when it is not text', async () => {
    await start(post('/api/bank/open-payments/connections', { bic: 'NDEASESS', method: 'qr', personal_number: '199001011239', psu_authoriser_id: ' corp-user-1 ' }), none)
    expect(service.startBankFeedConsent).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ bic: 'NDEASESS', signer: expect.objectContaining({ psuAuthoriserId: 'corp-user-1' }) }))
    await restart(post(`/api/bank/open-payments/connections/${ID}/restart`, { method: 'redirect', psu_authoriser_id: 'second-signer' }), params(ID))
    expect(service.restartBankFeedConsent).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ signer: expect.objectContaining({ psuAuthoriserId: 'second-signer' }) }))
    await poll(post(`/api/bank/open-payments/connections/${ID}/poll`, { psu_authoriser_id: 'corp-user-1' }), params(ID))
    expect(service.pollBankFeedConsent).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ signer: expect.objectContaining({ psuAuthoriserId: 'corp-user-1' }) }))
    // Nothing typed: no key at all.
    await poll(post(`/api/bank/open-payments/connections/${ID}/poll`, { personal_number: '199001011239' }), params(ID))
    expect(service.pollBankFeedConsent.mock.lastCall?.[1].signer).not.toHaveProperty('psuAuthoriserId')
    const refused = await start(post('/api/bank/open-payments/connections', { bic: 'NDEASESS', method: 'qr', psu_authoriser_id: 42 }), none)
    expect(refused.status).toBe(400)
  })

  it('POST select forwards the selection with null ledgers and the keep-alive, and maps a conflict', async () => {
    service.selectBankFeedAccounts.mockResolvedValue({ ok: true, data: { connection: {}, sync: null, sync_pending: true } })
    const response = await select(post(`/api/bank/open-payments/connections/${ID}/select`, { accounts: [{ uid: 'A', enabled: true, ledger_account: '1930' }, { uid: 'B', enabled: false, ledger_account: null }] }), params(ID))
    expect(response.status).toBe(200)
    expect(service.selectBankFeedAccounts).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      connectionId: ID, accounts: [{ uid: 'A', enabled: true, ledgerAccount: '1930' }, { uid: 'B', enabled: false, ledgerAccount: null }], method: null, returnTo: null, returnOrigin: null, keepAlive: expect.any(Function),
    }))
    // The page to come back to rides along, so Svea's second consent can sign on the bank's page.
    await select(post(`/api/bank/open-payments/connections/${ID}/select`, { accounts: [{ uid: 'A', enabled: true }], return_to: 'connections' }), params(ID))
    expect(service.selectBankFeedAccounts).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ returnTo: 'connections', returnOrigin: 'https://app.accounted.se' }))
    expect((await select(post(`/api/bank/open-payments/connections/${ID}/select`, { accounts: [{ uid: 'A', enabled: true }], return_to: '/evil' }), params(ID))).status).toBe(400)
    service.selectBankFeedAccounts.mockResolvedValue({ ok: false, code: 'BANK_SELECTION_LEDGER_CONFLICT' })
    const { status, body } = await parseJsonResponse<ErrorBody>(await select(post(`/api/bank/open-payments/connections/${ID}/select`, { accounts: [{ uid: 'A', enabled: true }] }), params(ID)))
    expect(status).toBe(400)
    expect(body.error.code).toBe('BANK_SELECTION_LEDGER_CONFLICT')
  })

  it('POST select lives on for the first import it answers before: the Pro-plan ceiling, not the 300 s that cut a two-year import', () => {
    expect(selectMaxDuration).toBe(800)
  })

  it('POST sync answers the runner\'s result and its cooldown as 429', async () => {
    service.syncBankFeedConnection.mockResolvedValue({ ok: true, data: { connection_id: ID, bank: 'Swedbank', imported: 3, duplicates: 0, from_date: '2026-10-05', to_date: '2026-10-12', last_synced_at: 'x' } })
    const ok = await parseJsonResponse<{ data: { imported: number } }>(await sync(post(`/api/bank/open-payments/connections/${ID}/sync`), params(ID)))
    expect(ok.status).toBe(200)
    expect(ok.body.data.imported).toBe(3)
    service.syncBankFeedConnection.mockResolvedValue({ ok: false, code: 'BANK_SYNC_COOLDOWN', details: { next_allowed_at: 'soon' } })
    const cooldown = await parseJsonResponse<ErrorBody>(await sync(post(`/api/bank/open-payments/connections/${ID}/sync`), params(ID)))
    expect(cooldown.status).toBe(429)
    expect(cooldown.body.error.code).toBe('BANK_SYNC_COOLDOWN')
  })

  it('GET and DELETE connection pass the id through', async () => {
    service.getBankFeedConnection.mockResolvedValue({ ok: true, data: { connection_id: ID } })
    expect((await connection(createMockRequest(`/api/bank/open-payments/connections/${ID}`), params(ID))).status).toBe(200)
    expect(service.getBankFeedConnection).toHaveBeenCalledWith(expect.anything(), ID)
    service.disconnectBankFeedConnection.mockResolvedValue({ ok: true, data: { connection_id: ID } })
    const { status, body } = await parseJsonResponse<{ data: { connection_id: string } }>(await disconnect(createMockRequest(`/api/bank/open-payments/connections/${ID}`, { method: 'DELETE' }), params(ID)))
    expect(status).toBe(200)
    expect(body.data.connection_id).toBe(ID)
  })
})

describe('GET /api/bank/open-payments/sync/cron', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 'secret')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.se')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key')
  })

  it('refuses a missing or wrong secret', async () => {
    expect((await cronRoute(createCronRequest('/api/bank/open-payments/sync/cron'))).status).toBe(401)
    expect((await cronRoute(createCronRequest('/api/bank/open-payments/sync/cron', 'Bearer wrong'))).status).toBe(401)
    expect(cron.run).not.toHaveBeenCalled()
  })

  it('runs the cron and answers its summary', async () => {
    cron.run.mockResolvedValue({ connector: true, staleAttemptsRemoved: 1, expired: 0, due: 2, synced: 2, failed: 0, skipped: {} })
    const { status, body } = await parseJsonResponse<{ synced: number }>(await cronRoute(createCronRequest('/api/bank/open-payments/sync/cron', 'Bearer secret')))
    expect(status).toBe(200)
    expect(body.synced).toBe(2)
  })
})
