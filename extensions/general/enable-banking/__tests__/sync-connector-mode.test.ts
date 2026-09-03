import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ upload: vi.fn(), connector: { value: null as null | { baseUrl: string; key: string } } }))
vi.mock('@/lib/core/documents/document-service', () => ({ uploadDocument: (...a: unknown[]) => h.upload(...a) }))
vi.mock('@/lib/connect/instance/upstreams', () => ({
  bankConnectorMode: () => h.connector.value,
  CONNECTOR_COMPANY_HEADER: 'X-Connector-Company',
}))
vi.mock('../lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('../lib/api-client')>('../lib/api-client')
  return { ...actual, getAllTransactionsWithRaw: vi.fn(), getAccountBalance: vi.fn().mockResolvedValue(null) }
})

import { syncAccountTransactions } from '../lib/sync'
import { SessionExpiredError } from '../lib/api-client'
import { buildStableExternalIds } from '@/lib/transactions/external-id'
import type { StoredAccount } from '../types'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const account: StoredAccount = {
  uid: 'acc-1',
  iban: 'SE45 5000 0000 0583 9825 7466',
  name: 'Företagskonto',
  currency: 'SEK',
  enabled: true,
  balance_updated_at: new Date().toISOString(),
}

/** A supabase stand-in that answers the connection lookup with the session id. */
const supabase = {
  from: (table: string) => {
    if (table !== 'bank_connections') throw new Error(`unexpected table ${table}`)
    const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: { session_id: 'sess-1' }, error: null }) }
    return chain
  },
} as never

const remote = {
  transactions: [
    { booking_date: '2026-09-01', amount: -125.5, currency: 'SEK', description: 'Kortköp ICA', counterparty_name: 'ICA Maxi', counterparty_account: 'SE45 5000 0000 0583 9825 7466', reference: null, merchant_category_code: '5411', bank_transaction_code: 'PMNT/CCRD', proprietary_bank_transaction_code: null },
    { booking_date: '2026-09-01', amount: -125.5, currency: 'SEK', description: 'Kortköp ICA', counterparty_name: 'ICA Maxi', counterparty_account: '123456789', reference: null, merchant_category_code: null, bank_transaction_code: null, proprietary_bank_transaction_code: null },
  ],
  raw_pages: ['{"page":1}', '{"page":2}'],
  skipped_pending: 1,
  returned_min_booking_date: '2026-09-01',
  returned_max_booking_date: '2026-09-01',
  effective_date_from: null,
  pages: 2,
}

beforeEach(() => {
  vi.clearAllMocks()
  h.connector.value = { baseUrl: 'https://connect.accounted.se/api/connect/bank', key: 'gnubok_ck_test' }
  h.upload.mockResolvedValue({ id: 'doc' })
})
afterEach(() => vi.unstubAllEnvs())

describe('syncAccountTransactions in connector mode', () => {
  it('calls the connector sync operation and ingests with the same stored keys the direct path mints', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(remote), { status: 200, headers: { 'content-type': 'application/json' } }))
    const ingest = vi.fn().mockResolvedValue({ imported: 2, duplicates: 0, errors: 0, reconciled: 0, auto_categorized: 0, auto_matched_invoices: 0, transaction_ids: [] })
    const result = await syncAccountTransactions(supabase, 'company-1', 'user-1', 'conn-1', account, '2026-08-01', '2026-09-03', ingest, { strategy: 'longest' })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://connect.accounted.se/api/connect/bank/sync')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gnubok_ck_test')
    expect((init.headers as Record<string, string>)['X-Connector-Company']).toBe('company-1')
    expect(JSON.parse(init.body as string)).toEqual({ session_id: 'sess-1', account_uid: 'acc-1', account_currency: 'SEK', date_from: '2026-08-01', date_to: '2026-09-03', strategy: 'longest' })

    const raw = ingest.mock.calls[0][3] as Array<{ external_id: string; date: string; amount: number; counterparty_iban: string | null; counterparty_account: string | null; import_source: string; bank_connection_id: string }>
    const expectedIds = buildStableExternalIds('eb', 'SE4550000000058398257466', [{ date: '2026-09-01', amount: -125.5 }, { date: '2026-09-01', amount: -125.5 }])
    expect(raw.map((r) => r.external_id)).toEqual(expectedIds)
    expect(raw[0]).toMatchObject({ date: '2026-09-01', amount: -125.5, counterparty_iban: 'SE4550000000058398257466', counterparty_account: null, import_source: 'enable_banking', bank_connection_id: 'conn-1' })
    expect(raw[1]).toMatchObject({ counterparty_iban: null, counterparty_account: '123456789' })
    expect(account.dedup_scope).toBe('SE4550000000058398257466')
    expect(h.upload).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ imported: 2, returnedMinBookingDate: '2026-09-01', returnedMaxBookingDate: '2026-09-01' })
  })

  it('maps the connector 410 onto SessionExpiredError so callers flip the connection to expired', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'expired', code: 'CONNECTOR_BANK_SESSION_EXPIRED', retryable: false }), { status: 410 }))
    await expect(syncAccountTransactions(supabase, 'company-1', 'user-1', 'conn-1', account, '2026-08-01', '2026-09-03', vi.fn())).rejects.toBeInstanceOf(SessionExpiredError)
  })

  it('surfaces other connector failures as errors and refuses an unexpected response shape', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'busy', code: 'CONNECTOR_RATE_LIMITED' }), { status: 429 }))
    await expect(syncAccountTransactions(supabase, 'company-1', 'user-1', 'conn-1', account, '2026-08-01', '2026-09-03', vi.fn())).rejects.toThrow(/CONNECTOR_RATE_LIMITED/)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ transactions: 'nope' }), { status: 200 }))
    await expect(syncAccountTransactions(supabase, 'company-1', 'user-1', 'conn-1', account, '2026-08-01', '2026-09-03', vi.fn())).rejects.toThrow(/unexpected shape/)
  })
})
