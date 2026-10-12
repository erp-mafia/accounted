import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedBankTransaction } from '@accounted/connect-contract'
import { buildStableExternalIds } from '@/lib/transactions/external-id'
import type { BankIngestRoute } from '@/types'

const mocks = vi.hoisted(() => ({ upload: vi.fn(), ingest: vi.fn() }))
vi.mock('@/lib/core/documents/document-service', () => ({ uploadDocument: (...a: unknown[]) => mocks.upload(...a) }))
vi.mock('@/lib/transactions/ingest', () => ({ ingestTransactions: (...a: unknown[]) => mocks.ingest(...a) }))

import { ConsentOverError, type BankFeedConnect } from '../connect'
import { accountDedupScope, mapBankFeedRows, syncOpenPaymentsAccount, type BankFeedAccount } from '../sync'

const PARTY = { orgNumber: '5595386219', accountContext: 'corporate' as const, bic: 'SWEDSESS', personalNumber: null, psuIpAddress: null, psuUserAgent: null, affiliatedAspspId: null }
const ROUTE: BankIngestRoute = { connectionId: 'conn-1', sessionId: 'consent-1', accountUid: 'ACC003', cashAccountId: 'cash-1', ledgerAccount: '1930', currency: 'SEK', token: 't', aggregator: 'open_payments', bic: 'SWEDSESS' }

const row = (overrides: Partial<NormalizedBankTransaction> = {}): NormalizedBankTransaction => ({
  booking_date: '2026-10-01', amount: -125.5, currency: 'SEK', description: 'Kortköp ICA', counterparty_name: 'ICA Maxi',
  counterparty_account: null, reference: null, merchant_category_code: '5411', bank_transaction_code: 'PMNT/CCRD', proprietary_bank_transaction_code: null,
  ...overrides,
})

function page(rows: NormalizedBankTransaction[], extra: Record<string, unknown> = {}) {
  return { transactions: rows, raw_pages: ['{"page":1}'], skipped_pending: 0, returned_min_booking_date: '2026-10-01', returned_max_booking_date: '2026-10-01', effective_date_from: null, pages: 1, ...extra }
}

function fakeConnect(overrides: Partial<BankFeedConnect> = {}): BankFeedConnect {
  return {
    banks: vi.fn(), bank: vi.fn(), createConsent: vi.fn(), startConsentSigning: vi.fn(), pollConsentSigning: vi.fn(), consentStatus: vi.fn(),
    accounts: vi.fn(), balances: vi.fn().mockResolvedValue({ booked: 1000, available: 900 }),
    syncTransactions: vi.fn().mockResolvedValue(page([row()])), revokeConsent: vi.fn(),
    ...overrides,
  } as unknown as BankFeedConnect
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.upload.mockResolvedValue({ id: 'doc-1' })
  mocks.ingest.mockResolvedValue({ imported: 1, duplicates: 0, errors: 0, reconciled: 0, auto_categorized: 0, auto_matched_invoices: 0, transaction_ids: ['tx-1'] })
})

describe('mapBankFeedRows', () => {
  const account: BankFeedAccount = { uid: 'ACC003', currency: 'SEK', iban: 'SE80 5000 0000 0521 3123 4567' }

  it('mints the same eb external ids Enable Banking would, scoped by dedup_scope, else the IBAN, else the uid', () => {
    expect(accountDedupScope({ uid: 'u', iban: 'SE80 5000', dedup_scope: 'legacy' })).toBe('legacy')
    expect(accountDedupScope({ uid: 'u', iban: 'se80 5000 0000' })).toBe('SE8050000000')
    expect(accountDedupScope({ uid: 'u', iban: null })).toBe('u')
    const rows = [row(), row({ amount: -125.5 }), row({ booking_date: '2026-10-02', amount: 10 })]
    const mapped = mapBankFeedRows({ rows, account, connectionId: 'conn-1', archivedPageIds: ['doc-1'] })
    expect(mapped.rows.map((r) => r.external_id)).toEqual(buildStableExternalIds('eb', 'SE8050000000052131234567', rows.map((r) => ({ date: r.booking_date, amount: r.amount }))))
    expect(mapped.scope).toBe('SE8050000000052131234567')
    expect(mapped.minBookingDate).toBe('2026-10-01')
    expect(mapped.maxBookingDate).toBe('2026-10-02')
  })

  it('carries what Open Payments reports: source, value date, end-to-end id, provider id, counterparty IBAN, the archived page', () => {
    const [mapped] = mapBankFeedRows({
      rows: [row({ value_date: '2026-10-02', end_to_end_id: 'E2E-1', provider_transaction_id: 'T-1', counterparty_iban: 'se45 5000 0000 0583 9825 7466', counterparty_account: '123456789', raw_page_index: 0, reference: '4711000000009' })],
      account, connectionId: 'conn-1', archivedPageIds: ['doc-1'],
    }).rows
    expect(mapped).toMatchObject({
      import_source: 'open_payments', bank_connection_id: 'conn-1', value_date: '2026-10-02', end_to_end_id: 'E2E-1', provider_transaction_id: 'T-1',
      counterparty_iban: 'SE4550000000058398257466', counterparty_account: '123456789', raw_document_id: 'doc-1', reference: '4711000000009',
      mcc_code: 5411, merchant_name: 'ICA Maxi', bank_transaction_code: 'PMNT/CCRD', currency: 'SEK',
    })
  })

  it('reads an IBAN-shaped counterparty account as the IBAN, and links no page when the index is unknown', () => {
    const [mapped] = mapBankFeedRows({
      rows: [row({ counterparty_account: 'SE45 5000 0000 0583 9825 7466', end_to_end_id: null })],
      account, connectionId: 'conn-1', archivedPageIds: ['doc-1'],
    }).rows
    expect(mapped.counterparty_iban).toBe('SE4550000000058398257466')
    expect(mapped.counterparty_account).toBeNull()
    expect(mapped.raw_document_id).toBeNull()
    expect(mapped.end_to_end_id).toBeNull()
  })
})

describe('syncOpenPaymentsAccount', () => {
  const account = (): BankFeedAccount => ({ uid: 'ACC003', currency: 'SEK', iban: 'SE8050000000052131234567', usage: 'ORGA' })

  it('asks the service for the window, archives every page, ingests with the route and refreshes a stale balance', async () => {
    const connect = fakeConnect()
    const acc = account()
    const result = await syncOpenPaymentsAccount({} as never, {
      companyId: 'co-1', userId: 'user-1', connectionId: 'conn-1', account: acc, fromDate: '2026-09-01', toDate: '2026-10-12', bankRoute: ROUTE, party: PARTY, connect, now: Date.parse('2026-10-12T10:00:00Z'),
    })
    expect(connect.syncTransactions).toHaveBeenCalledWith('co-1', { party: PARTY, consentId: 'consent-1', accountUid: 'ACC003', accountCurrency: 'SEK', accountUsage: 'ORGA', dateFrom: '2026-09-01', dateTo: '2026-10-12' })
    expect(mocks.upload).toHaveBeenCalledTimes(1)
    expect((mocks.upload.mock.calls[0] as unknown[])[3]).toMatchObject({ name: expect.stringMatching(/^psd2-response_conn-1_ACC003_.*_p1\.json$/), type: 'application/json' })
    const [, companyId, userId, rows, options] = mocks.ingest.mock.calls[0] as [unknown, string, string, Array<{ import_source: string; raw_document_id: string | null }>, { bankRoute: BankIngestRoute; settlementAccount: string }]
    expect([companyId, userId]).toEqual(['co-1', 'user-1'])
    expect(rows[0]).toMatchObject({ import_source: 'open_payments', bank_connection_id: 'conn-1' })
    expect(options).toMatchObject({ bankRoute: ROUTE, settlementAccount: '1930' })
    expect(connect.balances).toHaveBeenCalledWith('co-1', { party: PARTY, consentId: 'consent-1', accountUid: 'ACC003' })
    expect(acc).toMatchObject({ dedup_scope: 'SE8050000000052131234567', balance: 1000, available_balance: 900, balance_updated_at: '2026-10-12T10:00:00.000Z' })
    expect(result).toMatchObject({ imported: 1, duplicates: 0, errors: 0, transactionIds: ['tx-1'], returnedMinBookingDate: '2026-10-01', requestedFromDate: '2026-09-01', historyNarrowed: false, truncated: false })
  })

  it('links rows to the page they arrived in, and to nothing when the archive failed', async () => {
    mocks.upload.mockRejectedValueOnce(new Error('storage down'))
    const connect = fakeConnect({ syncTransactions: vi.fn().mockResolvedValue(page([row({ raw_page_index: 0 })])) })
    await syncOpenPaymentsAccount({} as never, { companyId: 'co-1', userId: 'user-1', connectionId: 'conn-1', account: account(), fromDate: '2026-09-01', toDate: '2026-10-12', bankRoute: ROUTE, party: PARTY, connect })
    const rows = (mocks.ingest.mock.calls[0] as unknown[])[3] as Array<{ raw_document_id: string | null }>
    expect(rows[0].raw_document_id).toBeNull()
  })

  it('keeps a fresh balance, forwards the ingest options, and reports a truncated or narrowed window', async () => {
    const connect = fakeConnect({ syncTransactions: vi.fn().mockResolvedValue(page([row()], { truncated: true, effective_date_from: '2026-09-15' })) })
    const acc = { ...account(), balance: 5, balance_updated_at: new Date().toISOString() }
    const result = await syncOpenPaymentsAccount({} as never, {
      companyId: 'co-1', userId: 'user-1', connectionId: 'conn-1', account: acc, fromDate: '2026-09-01', toDate: '2026-10-12', bankRoute: ROUTE, party: PARTY, connect,
      options: { skipAutoCategorization: true, rawInsertOnly: true },
    })
    expect(connect.balances).not.toHaveBeenCalled()
    expect(acc.balance).toBe(5)
    expect((mocks.ingest.mock.calls[0] as unknown[])[4]).toMatchObject({ skipAutoCategorization: true, rawInsertOnly: true })
    expect(result).toMatchObject({ truncated: true, historyNarrowed: true, effectiveFromDate: '2026-09-15' })
  })

  it('fails the sync when rows were rejected, keeping the cursor for a retry', async () => {
    mocks.ingest.mockResolvedValueOnce({ imported: 0, duplicates: 0, errors: 1, first_error: { code: 'PT409', message: 'route changed' }, transaction_ids: [] })
    await expect(syncOpenPaymentsAccount({} as never, { companyId: 'co-1', userId: 'user-1', connectionId: 'conn-1', account: account(), fromDate: '2026-09-01', toDate: '2026-10-12', bankRoute: ROUTE, party: PARTY, connect: fakeConnect() }))
      .rejects.toMatchObject({ code: 'PT409', message: expect.stringContaining('route changed') })
  })

  it('lets a consent that is over fail the sync even from the balance read, and swallows any other balance failure', async () => {
    const over = fakeConnect({ balances: vi.fn().mockRejectedValue(new ConsentOverError('over')) })
    await expect(syncOpenPaymentsAccount({} as never, { companyId: 'co-1', userId: 'user-1', connectionId: 'conn-1', account: account(), fromDate: '2026-09-01', toDate: '2026-10-12', bankRoute: ROUTE, party: PARTY, connect: over }))
      .rejects.toBeInstanceOf(ConsentOverError)
    const flaky = fakeConnect({ balances: vi.fn().mockRejectedValue(new Error('timeout')) })
    const acc = account()
    await expect(syncOpenPaymentsAccount({} as never, { companyId: 'co-1', userId: 'user-1', connectionId: 'conn-1', account: acc, fromDate: '2026-09-01', toDate: '2026-10-12', bankRoute: ROUTE, party: PARTY, connect: flaky })).resolves.toMatchObject({ imported: 1 })
    expect(acc.balance).toBeUndefined()
  })

  it('propagates the typed errors of the transactions read untouched', async () => {
    const connect = fakeConnect({ syncTransactions: vi.fn().mockRejectedValue(new ConsentOverError('gone')) })
    await expect(syncOpenPaymentsAccount({} as never, { companyId: 'co-1', userId: 'user-1', connectionId: 'conn-1', account: account(), fromDate: '2026-09-01', toDate: '2026-10-12', bankRoute: ROUTE, party: PARTY, connect }))
      .rejects.toBeInstanceOf(ConsentOverError)
    expect(mocks.ingest).not.toHaveBeenCalled()
  })
})
