import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenPaymentsApi, openPaymentsSignatoryBase } from '../open-payments-client'
import { createSignatoryBackend, createSignatoryPaymentsApi, keepSignatoryPersonalNumber, recallSignatoryPersonalNumber } from '../signatory-client'

function answering(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body })
}

const TOKEN = 'a'.repeat(43)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the Open Payments api bound to the signatory base', () => {
  it('sends every call to /api/koppla/<token>/... with the same bodies as the session door', async () => {
    const fetchMock = answering(200, { data: { connection_id: 'c-1' } })
    vi.stubGlobal('fetch', fetchMock)
    const api = createOpenPaymentsApi(openPaymentsSignatoryBase(TOKEN))
    await api.fetchBankDetails('SWEDSESS')
    await api.createConnection({ bic: 'SWEDSESS', method: 'redirect', personal_number: '199001011239', return_to: 'koppla' })
    await api.pollConnection('c-1')
    await api.pollConnection('c-1', undefined, { personal_number: '199001011239' })
    await api.restartConnection('c-1', { method: 'same_device', personal_number: '199001011239', return_to: 'koppla' })
    await api.selectAccounts('c-1', [{ uid: 'A', enabled: true, ledger_account: '1930' }], { personal_number: '199001011239' })
    await api.syncConnection('c-1')
    await api.fetchConnection('c-1')
    await api.deleteConnection('c-1')
    const calls = fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit)?.method ?? 'GET'} ${url}`)
    expect(calls).toEqual([
      `GET /api/koppla/${TOKEN}/banks/SWEDSESS`,
      `POST /api/koppla/${TOKEN}/connections`,
      `POST /api/koppla/${TOKEN}/connections/c-1/poll`,
      `POST /api/koppla/${TOKEN}/connections/c-1/poll`,
      `POST /api/koppla/${TOKEN}/connections/c-1/restart`,
      `POST /api/koppla/${TOKEN}/connections/c-1/select`,
      `POST /api/koppla/${TOKEN}/connections/c-1/sync`,
      `GET /api/koppla/${TOKEN}/connections/c-1`,
      `DELETE /api/koppla/${TOKEN}/connections/c-1`,
    ])
    const bodyOf = (i: number) => JSON.parse((fetchMock.mock.calls[i][1] as RequestInit).body as string)
    expect(bodyOf(1)).toEqual({ bic: 'SWEDSESS', method: 'redirect', personal_number: '199001011239', return_to: 'koppla' })
    // The poll sends an empty body, or the typed personnummer again so the bank sees the PSU on every call.
    expect(bodyOf(2)).toEqual({})
    expect(bodyOf(3)).toEqual({ personal_number: '199001011239' })
    expect(bodyOf(4)).toEqual({ method: 'same_device', personal_number: '199001011239', return_to: 'koppla' })
    expect(bodyOf(5)).toEqual({ accounts: [{ uid: 'A', enabled: true, ledger_account: '1930' }], personal_number: '199001011239' })
  })

  it('reads the banks from the token door and hides them on a refusal', async () => {
    vi.stubGlobal('fetch', answering(200, { data: { banks: [{ bic: 'SWEDSESS', name: 'Swedbank', logo_url: null, decoupled: true, redirect: null }] } }))
    const api = createOpenPaymentsApi(openPaymentsSignatoryBase(TOKEN))
    expect((await api.fetchAvailability()).available).toBe(true)
    vi.stubGlobal('fetch', answering(404, { error: { code: 'NOT_FOUND', message: 'x' } }))
    expect(await api.fetchAvailability()).toEqual({ available: false, banks: null })
  })
})

describe('the signatory payments api', () => {
  const base = openPaymentsSignatoryBase(TOKEN)

  const NOT_VERIFIED = { status: 'invalid', valid_until: null, state: 'link_expired', link_expires_at: '2026-10-12T09:00:00.000Z', checked_at: null }

  it('offers the verification while the company is not verified, with the state the door answered', async () => {
    vi.stubGlobal('fetch', answering(200, { data: NOT_VERIFIED }))
    expect(await createSignatoryPaymentsApi(base).probe()).toEqual({ offered: true, verification: NOT_VERIFIED })
  })

  it('makes no offer when the company is verified or may not pay through the bank', async () => {
    vi.stubGlobal('fetch', answering(200, { data: { status: 'valid', valid_until: '2027-01-01', state: 'valid', link_expires_at: null, checked_at: null } }))
    expect((await createSignatoryPaymentsApi(base).probe()).offered).toBe(false)
    vi.stubGlobal('fetch', answering(403, { error: { code: 'PAYMENTS_UNAVAILABLE', message: 'x' } }))
    expect(await createSignatoryPaymentsApi(base).probe()).toEqual({ offered: false, verification: null })
  })

  it('keeps the offer without a status when the provider is down', async () => {
    vi.stubGlobal('fetch', answering(503, { error: { code: 'PAYMENT_PROVIDER_UNAVAILABLE', message: 'x' } }))
    expect(await createSignatoryPaymentsApi(base).probe()).toEqual({ offered: true, verification: null })
  })

  it('polls with refresh and starts the form through the token door, never as a hand-off', async () => {
    const started = { url: 'https://verify.example/form', expires_at: '2026-10-15T09:00:00.000Z', state: 'form_open' }
    const fetchMock = answering(200, { data: started })
    vi.stubGlobal('fetch', fetchMock)
    expect(await createSignatoryPaymentsApi(base).startVerification()).toEqual(started)
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/koppla/${TOKEN}/verification/start`)
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({})
    await createSignatoryPaymentsApi(base).fetchVerification({ refresh: true })
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/koppla/${TOKEN}/verification?refresh=1`)
  })
})

describe('the signatory backend', () => {
  it('has nothing on file: the personnummer is typed, and payments follow the link', () => {
    const known: boolean[] = []
    const withPayments = createSignatoryBackend(TOKEN, { offerPayments: true })
    withPayments.watchSignerKnown((v) => known.push(v))()
    expect(known).toEqual([false])
    expect(withPayments.payments).not.toBeNull()
    expect(createSignatoryBackend(TOKEN, { offerPayments: false }).payments).toBeNull()
  })

  it('keeps the typed personnummer in this tab across the bank\'s own page, and hands it back once', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    })
    const backend = createSignatoryBackend(TOKEN, { offerPayments: false })
    backend.beforeLeavingForBank?.('c-1', { personalNumber: '19900101-1239' } as never)
    expect([...store.values()]).toEqual(['199001011239'])
    // Keyed by the link and the connection: another connection recalls nothing.
    expect(recallSignatoryPersonalNumber(TOKEN, 'c-2')).toBeNull()
    expect(recallSignatoryPersonalNumber(TOKEN, 'c-1')).toBe('199001011239')
    expect(recallSignatoryPersonalNumber(TOKEN, 'c-1')).toBeNull()
    // An invalid number is never kept.
    keepSignatoryPersonalNumber(TOKEN, 'c-3', '123')
    expect(store.size).toBe(0)
  })

  it('survives a blocked storage', () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: () => {
          throw new Error('blocked')
        },
        setItem: () => {
          throw new Error('blocked')
        },
        removeItem: () => {},
      },
    })
    expect(() => keepSignatoryPersonalNumber(TOKEN, 'c-1', '199001011239')).not.toThrow()
    expect(recallSignatoryPersonalNumber(TOKEN, 'c-1')).toBeNull()
  })
})
