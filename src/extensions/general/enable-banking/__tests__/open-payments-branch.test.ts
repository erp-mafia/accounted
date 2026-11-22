import { beforeEach, describe, expect, it, vi } from 'vitest'

// syncAccountTransactions branches on the aggregator the ingest route names:
// an Open Payments row is read through lib/bank-feed/sync.ts, and its typed
// Connect failures come back as the classes every Enable Banking caller
// already dispatches on. An Enable Banking row (no aggregator on the route,
// or 'enable_banking') takes the path it always took.

const mocks = vi.hoisted(() => ({
  fetchEb: vi.fn(),
  balanceEb: vi.fn(),
  upload: vi.fn(),
  route: vi.fn(),
  syncOp: vi.fn(),
  party: vi.fn(),
}))
vi.mock('../lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api-client')>()),
  getAllTransactionsWithRaw: (...a: unknown[]) => mocks.fetchEb(...a),
  getAccountBalance: (...a: unknown[]) => mocks.balanceEb(...a),
}))
vi.mock('@/lib/core/documents/document-service', () => ({ uploadDocument: (...a: unknown[]) => mocks.upload(...a) }))
vi.mock('@/lib/bank-sync/ingest-route', () => ({ resolveBankIngestRoute: (...a: unknown[]) => mocks.route(...a) }))
vi.mock('@/lib/bank-feed/sync', () => ({ syncOpenPaymentsAccount: (...a: unknown[]) => mocks.syncOp(...a) }))
vi.mock('@/lib/bank-feed/party', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bank-feed/party')>()),
  buildBankFeedParty: (...a: unknown[]) => mocks.party(...a),
}))

import { ConsentOverError, ProviderUnavailableError, RateLimitedError } from '@/lib/bank-feed/connect'
import { AspspUnavailableError, ConnectorSyncError, SessionExpiredError } from '../lib/api-client'
import { syncAccountTransactions, toEnableBankingSyncError } from '../lib/sync'

const ingest = vi.fn()
const account = { uid: 'ACC003', currency: 'SEK', iban: 'SE8050000000052131234567', enabled: true, ledger_account: '1930' }
const supabase = {
  from: vi.fn(() => {
    const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: { affiliated_aspsp_id: '08999', psu_type: 'business' }, error: null }) }
    return chain
  }),
} as never

beforeEach(() => {
  vi.clearAllMocks()
  mocks.route.mockResolvedValue({ connectionId: 'conn-1', sessionId: 'consent-1', accountUid: 'ACC003', cashAccountId: 'cash-1', ledgerAccount: '1930', currency: 'SEK', token: 't', aggregator: 'open_payments', bic: 'SWEDSESS' })
  mocks.party.mockResolvedValue({ ok: true, party: { orgNumber: '5595386219', accountContext: 'corporate', bic: 'SWEDSESS', personalNumber: null, psuIpAddress: null, psuUserAgent: null, affiliatedAspspId: '08999' } })
  mocks.syncOp.mockResolvedValue({ imported: 2, duplicates: 1, errors: 0, transactionIds: ['t1', 't2'], returnedMinBookingDate: '2026-10-01', returnedMaxBookingDate: '2026-10-10', requestedFromDate: '2026-09-01', effectiveFromDate: undefined, historyNarrowed: false, truncated: false })
  ingest.mockResolvedValue({ imported: 0, duplicates: 0, errors: 0, transaction_ids: [] })
})

describe('syncAccountTransactions on an Open Payments route', () => {
  it('delegates to the core Open Payments sync with the row\'s party and never calls Enable Banking', async () => {
    const result = await syncAccountTransactions(supabase, 'co-1', 'user-1', 'conn-1', { ...account }, '2026-09-01', '2026-10-12', ingest, {
      skipAutoCategorization: true, signer: { personalNumber: null, ipAddress: '203.0.113.1', userAgent: 'UA' },
    })
    expect(result).toEqual({ imported: 2, duplicates: 1, errors: 0, transactionIds: ['t1', 't2'], returnedMinBookingDate: '2026-10-01', returnedMaxBookingDate: '2026-10-10', requestedFromDate: '2026-09-01', effectiveFromDate: undefined, historyNarrowed: false })
    expect(mocks.party).toHaveBeenCalledWith(supabase, expect.objectContaining({ bic: 'SWEDSESS', affiliatedAspspId: '08999', psuType: 'business', signer: expect.objectContaining({ ipAddress: '203.0.113.1' }) }))
    expect(mocks.syncOp).toHaveBeenCalledWith(supabase, expect.objectContaining({ companyId: 'co-1', connectionId: 'conn-1', fromDate: '2026-09-01', toDate: '2026-10-12', ingest, options: { skipAutoCategorization: true } }))
    expect(mocks.fetchEb).not.toHaveBeenCalled()
    expect(mocks.balanceEb).not.toHaveBeenCalled()
    expect(mocks.upload).not.toHaveBeenCalled()
  })

  it("hands the connection's bank to the core sync, which reads Nordea's card holds by it (crm#2076)", async () => {
    await syncAccountTransactions(supabase, 'co-1', 'user-1', 'conn-1', { ...account }, '2026-09-01', '2026-10-12', ingest, { bankName: 'Nordea' })
    expect(mocks.syncOp).toHaveBeenCalledWith(supabase, expect.objectContaining({ bankName: 'Nordea' }))

    mocks.syncOp.mockClear()
    await syncAccountTransactions(supabase, 'co-1', 'user-1', 'conn-1', { ...account }, '2026-09-01', '2026-10-12', ingest)
    expect(mocks.syncOp.mock.calls[0][1]).not.toHaveProperty('bankName')
  })

  it('still refuses a changed ledger before anything is fetched', async () => {
    await expect(syncAccountTransactions(supabase, 'co-1', 'user-1', 'conn-1', { ...account, ledger_account: '1931' }, '2026-09-01', '2026-10-12', ingest))
      .rejects.toMatchObject({ code: 'PT409' })
    expect(mocks.syncOp).not.toHaveBeenCalled()
  })

  it('translates the Connect failures into the Enable Banking classes its callers handle', async () => {
    expect(toEnableBankingSyncError(new ConsentOverError('over', { status: 410 }), '2026-09-01')).toBeInstanceOf(SessionExpiredError)
    const limited = toEnableBankingSyncError(new RateLimitedError('budget', { status: 429, retryAfterSeconds: 3600 }), '2026-09-01') as AspspUnavailableError
    expect(limited).toBeInstanceOf(AspspUnavailableError)
    expect(limited).toMatchObject({ reason: 'rate-limited', dateFrom: '2026-09-01', rateLimit: { dailyQuota: true, retryAfterSeconds: 3600 } })
    const down = toEnableBankingSyncError(new ProviderUnavailableError('down', { code: 'CONNECTOR_AIS_PROVIDER_FAILED', status: 502 }), '2026-09-01') as ConnectorSyncError
    expect(down).toBeInstanceOf(ConnectorSyncError)
    expect(down).toMatchObject({ status: 502, code: 'CONNECTOR_AIS_PROVIDER_FAILED' })
    const other = new Error('plain')
    expect(toEnableBankingSyncError(other, '2026-09-01')).toBe(other)
    mocks.syncOp.mockRejectedValueOnce(new ConsentOverError('over'))
    await expect(syncAccountTransactions(supabase, 'co-1', 'user-1', 'conn-1', { ...account }, '2026-09-01', '2026-10-12', ingest)).rejects.toBeInstanceOf(SessionExpiredError)
  })

  it('takes the Enable Banking path when the route names no aggregator or Enable Banking', async () => {
    mocks.route.mockResolvedValue({ connectionId: 'conn-1', sessionId: 'sess-1', accountUid: 'ACC003', cashAccountId: 'cash-1', ledgerAccount: '1930', currency: 'SEK', token: 't' })
    mocks.fetchEb.mockResolvedValue({ transactions: [], rawPages: [] })
    mocks.balanceEb.mockResolvedValue(null)
    await syncAccountTransactions(supabase, 'co-1', 'user-1', 'conn-1', { ...account }, '2026-09-01', '2026-10-12', ingest)
    expect(mocks.fetchEb).toHaveBeenCalledTimes(1)
    expect(mocks.syncOp).not.toHaveBeenCalled()
  })
})
