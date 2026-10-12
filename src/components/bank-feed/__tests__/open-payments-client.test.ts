import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOpenPaymentsConnection,
  deleteOpenPaymentsConnection,
  fetchOpenPaymentsAvailability,
  fetchOpenPaymentsOverview,
  isBankBusy,
  isSecondConsent,
  isSyncCooldown,
  OpenPaymentsClientError,
  pollOpenPaymentsConnection,
  restartOpenPaymentsConnection,
  selectOpenPaymentsAccounts,
  syncOpenPaymentsConnection,
} from '../open-payments-client'

function answering(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body })
}

const ATTEMPT = { authorisation_id: 'a', method: 'qr', state: 'pending', challenge: null, sca_status: null, step: null, failure_code: null, failure_text: null }
const VIEW = {
  connection_id: 'c-1',
  bank_name: 'Swedbank',
  bic: 'SWEDSESS',
  provider: 'open_payments',
  status: 'active',
  consent_expires: '2027-04-10',
  last_synced_at: null,
  initial_sync_completed_at: null,
  error_message: null,
  accounts: [{ uid: 'u', name: 'Företagskonto', iban: 'SE45', currency: 'SEK', enabled: true, ledger_account: '1930', usage: 'ORGA' }],
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchOpenPaymentsAvailability', () => {
  it('returns the banks (logo_url, decoupled, redirect) when the company is switched on', async () => {
    const banks = [{ bic: 'SWEDSESS', name: 'Swedbank', logo_url: null, decoupled: true, redirect: true }]
    vi.stubGlobal('fetch', answering(200, { data: { banks } }))
    expect(await fetchOpenPaymentsAvailability()).toEqual({ available: true, banks })
  })

  it('reads the 403 OPEN_BANKING_NOT_AVAILABLE as "hide the entry points", like any other failure', async () => {
    vi.stubGlobal('fetch', answering(403, { error: { code: 'OPEN_BANKING_NOT_AVAILABLE', message: 'x', message_en: 'y' } }))
    expect(await fetchOpenPaymentsAvailability()).toEqual({ available: false, banks: null })
    vi.stubGlobal('fetch', answering(500, null))
    expect(await fetchOpenPaymentsAvailability()).toEqual({ available: false, banks: null })
  })

  it('lets a network failure through (the caller decides whether to retry)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(fetchOpenPaymentsAvailability()).rejects.toBeInstanceOf(TypeError)
  })
})

describe('the session calls', () => {
  it('reads the overview with signer_known and the connections', async () => {
    vi.stubGlobal('fetch', answering(200, { data: { available: true, reason: null, connections: [VIEW], signer_known: true } }))
    const overview = await fetchOpenPaymentsOverview()
    expect(overview.signer_known).toBe(true)
    expect(overview.connections[0].connection_id).toBe('c-1')
  })

  it('posts the create body as the route expects it and unwraps data', async () => {
    const fetchMock = answering(200, { data: { connection_id: 'c-1', attempt: ATTEMPT } })
    vi.stubGlobal('fetch', fetchMock)
    const result = await createOpenPaymentsConnection({ bic: 'SWEDSESS', method: 'qr', account_context: 'corporate', personal_number: '199001010017', replace_connection_id: 'old' })
    expect(result.connection_id).toBe('c-1')
    expect(result.attempt.state).toBe('pending')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/bank/open-payments/connections')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ bic: 'SWEDSESS', method: 'qr', account_context: 'corporate', personal_number: '199001010017', replace_connection_id: 'old' })
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('poll sends an empty body, or the typed personnummer again so the bank sees the PSU on every call', async () => {
    const fetchMock = answering(200, { data: { connection_id: 'c-1', state: 'pending', method: 'qr', challenge: null, sca_status: null, step: null, failure_code: null, failure_text: null, status: 'pending' } })
    vi.stubGlobal('fetch', fetchMock)
    await pollOpenPaymentsConnection('c-1')
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({})
    await pollOpenPaymentsConnection('c-1', undefined, { personal_number: '199001010017' })
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(url).toBe('/api/bank/open-payments/connections/c-1/poll')
    expect(JSON.parse(init.body as string)).toEqual({ personal_number: '199001010017' })
  })

  it('restart carries the method and the typed personnummer again (the server stores none)', async () => {
    const fetchMock = answering(200, { data: { connection_id: 'c-1', attempt: { ...ATTEMPT, authorisation_id: 'a2' } } })
    vi.stubGlobal('fetch', fetchMock)
    await restartOpenPaymentsConnection('c-1', { method: 'same_device', personal_number: '199001010017' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/bank/open-payments/connections/c-1/restart')
    expect(JSON.parse(init.body as string)).toEqual({ method: 'same_device', personal_number: '199001010017' })
  })

  it('throws the error envelope with its code on a refused call', async () => {
    vi.stubGlobal('fetch', answering(409, { error: { code: 'BANK_CONNECTION_IN_PROGRESS', message: 'Pågår', message_en: 'In progress' } }))
    const error = await pollOpenPaymentsConnection('c-1').catch((e) => e)
    expect(error).toBeInstanceOf(OpenPaymentsClientError)
    expect((error as OpenPaymentsClientError).code).toBe('BANK_CONNECTION_IN_PROGRESS')
    expect((error as OpenPaymentsClientError).status).toBe(409)
  })

  it('select sends the accounts with the signer and answers with the connection, the sync or a second consent', async () => {
    const fetchMock = answering(200, { data: { connection: VIEW, sync: null, sync_pending: false, attempt: { ...ATTEMPT, step: 'consent' } } })
    vi.stubGlobal('fetch', fetchMock)
    const second = await selectOpenPaymentsAccounts('c-1', [{ uid: 'u', enabled: true, ledger_account: '1930' }], { method: 'qr' })
    expect(isSecondConsent(second)).toBe(true)
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({ accounts: [{ uid: 'u', enabled: true, ledger_account: '1930' }], method: 'qr' })

    vi.stubGlobal('fetch', answering(200, { data: { connection: VIEW, sync: { imported: 5, duplicates: 1, from: 'a', to: 'b' }, sync_pending: false } }))
    const live = await selectOpenPaymentsAccounts('c-1', [])
    expect(isSecondConsent(live)).toBe(false)
    expect(live.sync?.imported).toBe(5)

    vi.stubGlobal('fetch', answering(200, { data: { connection: VIEW, sync: null, sync_pending: true } }))
    const pending = await selectOpenPaymentsAccounts('c-1', [])
    expect(pending.sync).toBeNull()
    expect(pending.sync_pending).toBe(true)
  })

  it('sync answers with the import window; a 429 cooldown is the calm kind', async () => {
    vi.stubGlobal('fetch', answering(200, { data: { connection_id: 'c-1', bank: 'Swedbank', imported: 3, duplicates: 0, from_date: '2026-07-14', to_date: '2026-10-12', last_synced_at: '2026-10-12T10:00:00Z' } }))
    expect((await syncOpenPaymentsConnection('c-1')).imported).toBe(3)

    vi.stubGlobal('fetch', answering(429, { error: { code: 'BANK_SYNC_COOLDOWN', message: 'x', message_en: 'y', details: { next_allowed_at: '2026-10-12T11:00:00Z' } } }))
    const cooldown = await syncOpenPaymentsConnection('c-1').catch((e) => e)
    expect(isSyncCooldown(cooldown)).toBe(true)
    expect(isBankBusy(cooldown)).toBe(false)

    // The bank's short throttle is its own calm kind: one line, the feed tries again on its own.
    vi.stubGlobal('fetch', answering(429, { error: { code: 'BANK_THROTTLED', message: 'x', message_en: 'y', details: { next_allowed_at: '2026-10-12T10:01:00Z' } } }))
    const busy = await syncOpenPaymentsConnection('c-1').catch((e) => e)
    expect(isBankBusy(busy)).toBe(true)
    expect(isSyncCooldown(busy)).toBe(false)
    expect(isBankBusy(new Error('x'))).toBe(false)
    expect((cooldown as OpenPaymentsClientError).nextAllowedAt).toBe('2026-10-12T11:00:00Z')
    vi.stubGlobal('fetch', answering(429, { error: { code: 'BANK_RATE_LIMITED', message: 'x', message_en: 'y' } }))
    expect(isSyncCooldown(await syncOpenPaymentsConnection('c-1').catch((e) => e))).toBe(true)
    vi.stubGlobal('fetch', answering(500, { error: { code: 'BANK_SYNC_FAILED', message: 'x', message_en: 'y' } }))
    expect(isSyncCooldown(await syncOpenPaymentsConnection('c-1').catch((e) => e))).toBe(false)
  })

  it('delete unwraps the connection id', async () => {
    const fetchMock = answering(200, { data: { connection_id: 'c-1' } })
    vi.stubGlobal('fetch', fetchMock)
    expect(await deleteOpenPaymentsConnection('c-1')).toEqual({ connection_id: 'c-1' })
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].method).toBe('DELETE')
  })
})
