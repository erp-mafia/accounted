import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIS_OPERATIONS, CONTRACT_VERSION, type AisParty } from '@accounted/connect-contract'
import { ConnectorCallError, CONNECTOR_UNREACHABLE_CODE } from '@/lib/connect/instance/connector-fetch'
import {
  AIS_CONNECT_TIMEOUT_MS,
  AIS_SYNC_TIMEOUT_MS,
  BANK_DETAILS_TTL_MS,
  BANK_FEED_NOT_FOUND,
  BANK_FEED_THROTTLED,
  BankFeedError,
  BankFeedRefusedError,
  BankThrottledError,
  ConsentOverError,
  ProviderUnavailableError,
  RateLimitedError,
  clearBankDetailsCache,
  createBankFeedConnect,
  getBankFeedConnect,
  setBankFeedConnectForTests,
  toBankFeedError,
} from '../connect'

const UPSTREAM = { baseUrl: 'https://connect.example.se/api/connect/ais', key: 'gnubok_ck_secret' }
const PARTY: AisParty = {
  orgNumber: '5595386219',
  accountContext: 'corporate',
  bic: 'SWEDSESS',
  personalNumber: '199001011239',
  psuIpAddress: '203.0.113.10',
  psuUserAgent: 'UA',
  affiliatedAspspId: null,
}
const CHALLENGE = { approach: 'decoupled', autostartToken: 'tok', qrData: 'bankid.qr', qrImage: null, redirectUrl: null }

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}
function fetchAnswering(status: number, body: unknown, headers?: Record<string, string>) {
  return vi.fn().mockResolvedValue(jsonResponse(status, body, headers))
}
function adapter(fetchMock: ReturnType<typeof vi.fn>) {
  return createBankFeedConnect(UPSTREAM, { fetch: fetchMock as unknown as typeof fetch, timeoutMs: 1000, syncTimeoutMs: 2000 })
}
function sent(fetchMock: ReturnType<typeof vi.fn>): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  return { url, init, body: JSON.parse(init.body as string) as Record<string, unknown> }
}
async function failure(promise: Promise<unknown>): Promise<BankFeedError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(BankFeedError)
    return error as BankFeedError
  }
  throw new Error('expected a BankFeedError')
}

afterEach(() => {
  setBankFeedConnectForTests(undefined)
  clearBankDetailsCache()
})

describe('createBankFeedConnect', () => {
  it('sends every operation to its contract path with the connector headers and the company', async () => {
    const fetchMock = fetchAnswering(200, { banks: [{ bic: 'SWEDSESS', name: 'Swedbank', logoUrl: null, decoupled: true, redirect: null }] })
    const banks = await adapter(fetchMock).banks('co-1')
    expect(banks).toEqual([{ bic: 'SWEDSESS', name: 'Swedbank', logoUrl: null, decoupled: true, redirect: null }])
    const { url, init, body } = sent(fetchMock)
    expect(url).toBe(`${UPSTREAM.baseUrl}${AIS_OPERATIONS.banks.path}`)
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer gnubok_ck_secret')
    expect(headers['X-Connector-Company']).toBe('co-1')
    expect(headers['X-Connect-Contract-Version']).toBe(CONTRACT_VERSION)
    expect(body).toEqual({ country: 'SE' })
  })

  it('reads a bank, creates a consent and starts and polls its signing in the contract shapes', async () => {
    const bankFetch = fetchAnswering(200, {
      bic: 'SWEDSESS', name: 'Swedbank', decoupled: true, redirect: false, transactionHistoryMaxDays: 88,
      extendedTransactionHistoryMaxDays: 760, extendedTransactionHistoryAvailableWindowMinutes: 60, affiliates: [{ id: '08999', name: 'Sparbanken Nord' }],
    })
    const bank = await adapter(bankFetch).bank('co-1', 'SWEDSESS')
    expect(bank.extendedTransactionHistoryMaxDays).toBe(760)
    expect(sent(bankFetch).url).toBe(`${UPSTREAM.baseUrl}/bank`)

    const createFetch = fetchAnswering(200, { consentId: 'c-1', consentStatus: 'received', validUntil: '2027-04-10' })
    const created = await adapter(createFetch).createConsent('co-1', { party: PARTY, validUntil: '2027-04-10', accounts: [{ iban: 'SE1' }] })
    expect(created.consentId).toBe('c-1')
    expect(sent(createFetch).body).toEqual({ party: PARTY, validUntil: '2027-04-10', accounts: [{ iban: 'SE1' }] })

    const startFetch = fetchAnswering(200, { providerAuthorisationId: 'a-1', method: 'qr', state: 'pending', challenge: CHALLENGE, failureCode: null, scaStatus: 'started' })
    const started = await adapter(startFetch).startConsentSigning('co-1', { party: PARTY, consentId: 'c-1', method: 'qr' })
    expect(started).toMatchObject({ providerAuthorisationId: 'a-1', state: 'pending', scaStatus: 'started' })
    expect(sent(startFetch).url).toBe(`${UPSTREAM.baseUrl}/consents/signings`)

    const pollFetch = fetchAnswering(200, { state: 'valid', challenge: null, failureCode: null, scaStatus: 'finalised', consentStatus: 'valid', validUntil: '2027-04-10' })
    const progress = await adapter(pollFetch).pollConsentSigning('co-1', { party: PARTY, consentId: 'c-1', providerAuthorisationId: 'a-1', method: 'qr' })
    expect(progress).toMatchObject({ state: 'valid', validUntil: '2027-04-10' })
    expect(sent(pollFetch).url).toBe(`${UPSTREAM.baseUrl}/consents/signings/poll`)
  })

  it('starts a signing on the bank\'s own page with the return URL and state, in the contract shape', async () => {
    const challenge = { approach: 'redirect', autostartToken: null, qrData: null, qrImage: null, redirectUrl: 'https://bank.example/sign' }
    const startFetch = fetchAnswering(200, { providerAuthorisationId: 'a-r', method: 'redirect', state: 'pending', challenge, failureCode: null, scaStatus: null })
    const started = await adapter(startFetch).startConsentSigning('co-1', {
      party: PARTY, consentId: 'c-1', method: 'redirect', returnUrl: 'https://app.accounted.se/settings/connections?bank_connect=c-1', returnState: 'c-1',
    })
    expect(started).toMatchObject({ method: 'redirect', state: 'pending', challenge })
    expect(sent(startFetch).body).toMatchObject({ method: 'redirect', returnUrl: 'https://app.accounted.se/settings/connections?bank_connect=c-1', returnState: 'c-1' })
    // A redirect without its return fails the contract before anything is sent.
    const idle = vi.fn()
    const refused = await failure(adapter(idle).startConsentSigning('co-1', { party: PARTY, consentId: 'c-1', method: 'redirect' }))
    expect(refused).toBeInstanceOf(BankFeedRefusedError)
    expect(idle).not.toHaveBeenCalled()
  })

  it('keeps a bank\'s details for a day, per BIC, and asks again after that', async () => {
    const details = { bic: 'SWEDSESS', name: 'Swedbank', decoupled: true, redirect: true, transactionHistoryMaxDays: 88, extendedTransactionHistoryMaxDays: 760, extendedTransactionHistoryAvailableWindowMinutes: 60, affiliates: [{ id: '08999', name: 'Sparbanken Nord' }] }
    // A fresh Response per call: a body can be read once.
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(200, details)))
    let clock = Date.parse('2026-10-12T10:00:00Z')
    const connect = createBankFeedConnect(UPSTREAM, { fetch: fetchMock as unknown as typeof fetch, now: () => clock })
    expect(await connect.getBankDetails('co-1', 'SWEDSESS')).toEqual(details)
    // The same bank for another company, spelled in lower case: one read serves both.
    expect(await connect.getBankDetails('co-2', 'swedsess')).toEqual(details)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Another bank is its own read; the plain `bank` never reads the cache.
    await connect.getBankDetails('co-1', 'ESSESESS')
    await connect.bank('co-1', 'SWEDSESS')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    clock += BANK_DETAILS_TTL_MS + 1
    await connect.getBankDetails('co-1', 'SWEDSESS')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('lists accounts, reads balances and transactions, and revokes a consent', async () => {
    const account = { uid: 'ACC003', currency: 'SEK', iban: 'SE8050000000052131234567', bban: '80000052131234567', name: 'Företagskonto', usage: 'ORGA', ownerName: 'Bolaget AB', bankgiro: null, plusgiro: null, balance: 1200.5, availableBalance: 1100 }
    const accountsFetch = fetchAnswering(200, { accounts: [account] })
    expect(await adapter(accountsFetch).accounts('co-1', { party: PARTY, consentId: 'c-1', withBalance: true })).toEqual([account])

    const balancesFetch = fetchAnswering(200, { booked: 10, available: null })
    expect(await adapter(balancesFetch).balances('co-1', { party: PARTY, consentId: 'c-1', accountUid: 'ACC003' })).toEqual({ booked: 10, available: null })
    expect(sent(balancesFetch).url).toBe(`${UPSTREAM.baseUrl}/accounts/balances`)

    const syncFetch = fetchAnswering(200, {
      transactions: [{ booking_date: '2026-10-01', amount: -25, currency: 'SEK', description: 'Avgift', counterparty_name: null, counterparty_account: null, reference: null, merchant_category_code: null, bank_transaction_code: null, proprietary_bank_transaction_code: null, end_to_end_id: 'E2E-1', counterparty_iban: null, value_date: '2026-10-01', provider_transaction_id: 'T1' }],
      raw_pages: ['{}'], skipped_pending: 0, returned_min_booking_date: '2026-10-01', returned_max_booking_date: '2026-10-01', effective_date_from: null, pages: 1, truncated: false, duplicates: 0, conflicts: 0,
    })
    const synced = await adapter(syncFetch).syncTransactions('co-1', { party: PARTY, consentId: 'c-1', accountUid: 'ACC003', accountCurrency: 'SEK', dateFrom: '2026-09-01' })
    expect(synced.transactions[0]).toMatchObject({ end_to_end_id: 'E2E-1', provider_transaction_id: 'T1' })
    expect(synced.truncated).toBe(false)
    expect(sent(syncFetch).url).toBe(`${UPSTREAM.baseUrl}/sync`)

    const revokeFetch = fetchAnswering(200, { revoked: true })
    expect(await adapter(revokeFetch).revokeConsent('co-1', { party: PARTY, consentId: 'c-1' })).toEqual({ revoked: true })
    expect(sent(revokeFetch).url).toBe(`${UPSTREAM.baseUrl}/consents/revoke`)
  })

  it('refuses a request that fails the contract before anything is sent', async () => {
    const fetchMock = fetchAnswering(200, {})
    const error = await failure(adapter(fetchMock).createConsent('co-1', { party: { ...PARTY, orgNumber: '55-95' }, validUntil: '2027-04-10' }))
    expect(error).toBeInstanceOf(BankFeedRefusedError)
    expect(error.code).toBe('CONNECTOR_REQUEST_INVALID')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats the service failing to record a redirect return as the provider being unavailable, and a return URL off our origin as a refusal', async () => {
    const start = { party: PARTY, consentId: 'c-1', method: 'redirect' as const, returnUrl: 'https://app.accounted.se/settings/connections?bank_connect=c-1', returnState: 'c-1' }
    const ledger = await failure(adapter(fetchAnswering(503, { error: 'ledger', code: 'CONNECTOR_LEDGER_FAILED', retryable: true })).startConsentSigning('co-1', start))
    expect(ledger).toBeInstanceOf(ProviderUnavailableError)
    expect(ledger.code).toBe('CONNECTOR_LEDGER_FAILED')
    const offOrigin = await failure(adapter(fetchAnswering(400, { error: 'origin', code: 'CONNECTOR_REDIRECT_INVALID' })).startConsentSigning('co-1', start))
    expect(offOrigin).toBeInstanceOf(BankFeedRefusedError)
    expect(offOrigin.code).toBe('CONNECTOR_REDIRECT_INVALID')
  })

  it('maps the service envelope onto the typed errors', async () => {
    const over = await failure(adapter(fetchAnswering(410, { error: 'over', code: 'CONNECTOR_BANK_SESSION_EXPIRED' })).consentStatus('co-1', { party: PARTY, consentId: 'c-1' }))
    expect(over).toBeInstanceOf(ConsentOverError)
    expect(over.status).toBe(410)

    const limited = await failure(adapter(fetchAnswering(429, { error: 'budget', code: 'CONNECTOR_BANK_RATE_LIMITED', retryable: true }, { 'Retry-After': '3600' }))
      .balances('co-1', { party: PARTY, consentId: 'c-1', accountUid: 'A' }))
    expect(limited).toBeInstanceOf(RateLimitedError)
    expect((limited as RateLimitedError).retryAfterSeconds).toBe(3600)

    // The bank's short throttle is its own error, never mistaken for the daily cap.
    const throttled = await failure(adapter(fetchAnswering(429, { error: 'busy', code: 'CONNECTOR_BANK_THROTTLED', retryable: true }, { 'Retry-After': '45' }))
      .syncTransactions('co-1', { party: PARTY, consentId: 'c-1', accountUid: 'A', accountCurrency: 'SEK', dateFrom: '2026-10-01' }))
    expect(throttled).toBeInstanceOf(BankThrottledError)
    expect(throttled).not.toBeInstanceOf(RateLimitedError)
    expect(throttled.code).toBe(BANK_FEED_THROTTLED)
    expect(throttled.retryable).toBe(true)
    expect((throttled as BankThrottledError).retryAfterSeconds).toBe(45)

    const refused = await failure(adapter(fetchAnswering(422, { error: 'no', code: 'CONNECTOR_AIS_REFUSED', providerCode: 'PSU_RIGHTS_MISSING' }))
      .createConsent('co-1', { party: PARTY }))
    expect(refused).toBeInstanceOf(BankFeedRefusedError)
    expect(refused.providerCode).toBe('PSU_RIGHTS_MISSING')

    const missing = await failure(adapter(fetchAnswering(404, { error: 'gone', code: 'CONNECTOR_AIS_NOT_FOUND' })).consentStatus('co-1', { party: PARTY, consentId: 'x' }))
    expect(missing.code).toBe(BANK_FEED_NOT_FOUND)
    expect(missing.retryable).toBe(false)

    const down = await failure(adapter(fetchAnswering(503, { error: 'down', code: 'CONNECTOR_AIS_PROVIDER_UNAVAILABLE', retryable: true })).banks('co-1'))
    expect(down).toBeInstanceOf(ProviderUnavailableError)
    expect(down.retryable).toBe(true)
  })

  it('treats a lost answer, a 5xx and the service budget as the provider being unavailable', () => {
    for (const code of ['CONNECTOR_AIS_OUTCOME_UNKNOWN', 'CONNECTOR_AIS_PROVIDER_FAILED', 'CONNECTOR_RATE_LIMITED', CONNECTOR_UNREACHABLE_CODE, 'HTTP_502']) {
      const mapped = toBankFeedError(new ConnectorCallError('x', { code, retryable: true, status: 502 }), 'syncTransactions')
      expect(mapped, code).toBeInstanceOf(ProviderUnavailableError)
    }
    const config = toBankFeedError(new ConnectorCallError('scope', { code: 'CONNECTOR_SCOPE_MISSING', retryable: false, status: 403 }), 'banks')
    expect(config).toBeInstanceOf(BankFeedRefusedError)
    expect(toBankFeedError(new Error('boom'), 'banks')).toBeInstanceOf(BankFeedRefusedError)
    const passthrough = new ConsentOverError('already typed')
    expect(toBankFeedError(passthrough, 'banks')).toBe(passthrough)
  })

  it('gives a transactions read the longer timeout and every other call the short one', () => {
    expect(AIS_SYNC_TIMEOUT_MS).toBeGreaterThan(AIS_CONNECT_TIMEOUT_MS)
    // A fetch that only ends when the adapter's own timeout aborts it.
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const slow = createBankFeedConnect(UPSTREAM, { fetch: fetchMock as unknown as typeof fetch, timeoutMs: 5, syncTimeoutMs: 50 })
    return expect(slow.banks('co-1')).rejects.toBeInstanceOf(ProviderUnavailableError)
  })
})

describe('getBankFeedConnect', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })
  afterEach(() => vi.unstubAllEnvs())

  it('is null without a connector key and an adapter with one', () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', '')
    expect(getBankFeedConnect()).toBeNull()
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_test')
    vi.stubEnv('GNUBOK_CONNECT_URL', 'https://connect.example.se')
    expect(getBankFeedConnect()).not.toBeNull()
  })

  it('honours the test override, null included', () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_test')
    setBankFeedConnectForTests(null)
    expect(getBankFeedConnect()).toBeNull()
  })
})
