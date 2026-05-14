import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock api-client
const mockGetAllTransactionsWithRaw = vi.fn()
const mockConvertTransaction = vi.fn()
const mockGetAccountBalance = vi.fn()
vi.mock('../api-client', () => ({
  getAllTransactionsWithRaw: (...args: unknown[]) => mockGetAllTransactionsWithRaw(...args),
  convertTransaction: (...args: unknown[]) => mockConvertTransaction(...args),
  getAccountBalance: (...args: unknown[]) => mockGetAccountBalance(...args),
}))

// Mock document service
const mockUploadDocument = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: (...args: unknown[]) => mockUploadDocument(...args),
}))

// Mock ingest
const mockIngest = vi.fn()

import { syncAccountTransactions } from '../sync'
import type { StoredAccount } from '../../types'

const USER_ID = 'user-1'
const COMPANY_ID = 'company-1'
const CONNECTION_ID = 'conn-1'

function makeAccount(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    uid: 'acc-uid-1',
    currency: 'SEK',
    ...overrides,
  }
}

describe('syncAccountTransactions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAccountBalance.mockRejectedValue(new Error('skip'))
    mockIngest.mockResolvedValue({ imported: 1, duplicates: 0, errors: 0, reconciled: 0, auto_categorized: 0, auto_matched_invoices: 0, transaction_ids: ['tx-1'] })
  })

  it('calls uploadDocument for each raw page with correct filename pattern', async () => {
    const rawPage1 = JSON.stringify({ transactions: [{ transaction_amount: { amount: '100', currency: 'SEK' } }] })
    const rawPage2 = JSON.stringify({ transactions: [{ transaction_amount: { amount: '200', currency: 'SEK' } }] })

    mockGetAllTransactionsWithRaw.mockResolvedValue({
      transactions: [
        { transaction_amount: { amount: '100', currency: 'SEK' } },
        { transaction_amount: { amount: '200', currency: 'SEK' } },
      ],
      rawPages: [rawPage1, rawPage2],
    })

    mockConvertTransaction.mockImplementation((tx: { transaction_amount: { amount: string } }) => ({
      id: `tx-${tx.transaction_amount.amount}`,
      date: '2024-06-15',
      booking_date: '2024-06-15',
      amount: parseFloat(tx.transaction_amount.amount),
      currency: 'SEK',
      description: 'Test',
    }))

    mockUploadDocument.mockResolvedValue({ id: 'doc-1' })

    const account = makeAccount()
    await syncAccountTransactions(
      {} as never,
      COMPANY_ID,
      USER_ID,
      CONNECTION_ID,
      account,
      '2024-01-01',
      '2024-12-31',
      mockIngest
    )

    expect(mockUploadDocument).toHaveBeenCalledTimes(2)

    // Verify filename pattern
    const firstCall = mockUploadDocument.mock.calls[0]
    expect(firstCall[3].name).toMatch(/^psd2-response_conn-1_acc-uid-1_.*_p1\.json$/)
    expect(firstCall[3].type).toBe('application/json')
    expect(firstCall[4]).toEqual({ upload_source: 'api' })

    const secondCall = mockUploadDocument.mock.calls[1]
    expect(secondCall[3].name).toMatch(/^psd2-response_conn-1_acc-uid-1_.*_p2\.json$/)
  })

  it('completes sync even if uploadDocument throws', async () => {
    mockGetAllTransactionsWithRaw.mockResolvedValue({
      transactions: [{ transaction_amount: { amount: '100', currency: 'SEK' } }],
      rawPages: ['{"transactions":[]}'],
    })

    mockConvertTransaction.mockReturnValue({
      id: 'tx-1',
      date: '2024-06-15',
      booking_date: '2024-06-15',
      amount: 100,
      currency: 'SEK',
      description: 'Test',
    })

    mockUploadDocument.mockRejectedValue(new Error('Storage error'))

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const account = makeAccount()
    const result = await syncAccountTransactions(
      {} as never,
      COMPANY_ID,
      USER_ID,
      CONNECTION_ID,
      account,
      '2024-01-01',
      '2024-12-31',
      mockIngest
    )

    expect(result.imported).toBe(1)
    expect(result.errors).toBe(0)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to archive raw response'),
      expect.any(Error)
    )

    errorSpy.mockRestore()
  })

  it('forwards strategy from sync options to getAllTransactionsWithRaw', async () => {
    mockGetAllTransactionsWithRaw.mockResolvedValue({
      transactions: [],
      rawPages: ['{}'],
    })
    mockUploadDocument.mockResolvedValue({ id: 'doc-1' })

    await syncAccountTransactions(
      {} as never,
      COMPANY_ID,
      USER_ID,
      CONNECTION_ID,
      makeAccount(),
      '2024-01-01',
      '2024-12-31',
      mockIngest,
      { strategy: 'longest' }
    )

    expect(mockGetAllTransactionsWithRaw).toHaveBeenCalledWith(
      'acc-uid-1',
      '2024-01-01',
      '2024-12-31',
      'longest'
    )
  })

  it('omits strategy when sync options do not include it', async () => {
    mockGetAllTransactionsWithRaw.mockResolvedValue({
      transactions: [],
      rawPages: ['{}'],
    })
    mockUploadDocument.mockResolvedValue({ id: 'doc-1' })

    await syncAccountTransactions(
      {} as never,
      COMPANY_ID,
      USER_ID,
      CONNECTION_ID,
      makeAccount(),
      '2024-01-01',
      '2024-12-31',
      mockIngest
    )

    expect(mockGetAllTransactionsWithRaw).toHaveBeenCalledWith(
      'acc-uid-1',
      '2024-01-01',
      '2024-12-31',
      undefined
    )
  })

  it('passes raw transactions to ingest function', async () => {
    mockGetAllTransactionsWithRaw.mockResolvedValue({
      transactions: [{ transaction_amount: { amount: '500', currency: 'SEK' } }],
      rawPages: ['{}'],
    })

    mockConvertTransaction.mockReturnValue({
      id: 'tx-500',
      date: '2024-06-15',
      booking_date: '2024-06-15',
      amount: -500,
      currency: 'SEK',
      description: 'Purchase',
      counterparty_name: 'Store',
      merchant_category_code: '5411',
    })

    mockUploadDocument.mockResolvedValue({ id: 'doc-1' })

    const account = makeAccount()
    await syncAccountTransactions(
      {} as never,
      COMPANY_ID,
      USER_ID,
      CONNECTION_ID,
      account,
      '2024-01-01',
      '2024-12-31',
      mockIngest
    )

    expect(mockIngest).toHaveBeenCalledTimes(1)
    const rawTxns = mockIngest.mock.calls[0][3]
    expect(rawTxns).toHaveLength(1)
    expect(rawTxns[0].external_id).toBe('eb_acc-uid-1_tx-500')
    expect(rawTxns[0].import_source).toBe('enable_banking')
  })

  it('returns the min/max booking date the ASPSP returned for the activation UI', async () => {
    // The min/max loop reads booking_date from the *raw* transactions (sync.ts:75-82),
    // before convertTransaction runs — so the dates need to be set here.
    mockGetAllTransactionsWithRaw.mockResolvedValue({
      transactions: [
        { transaction_amount: { amount: '100', currency: 'SEK' }, booking_date: '2026-04-15' },
        { transaction_amount: { amount: '200', currency: 'SEK' }, booking_date: '2026-02-20' },
        { transaction_amount: { amount: '300', currency: 'SEK' }, booking_date: '2026-05-10' },
      ],
      rawPages: ['{}'],
    })

    mockConvertTransaction.mockImplementation((tx: { transaction_amount: { amount: string }, booking_date: string }) => ({
      id: `tx-${tx.transaction_amount.amount}`,
      date: tx.booking_date,
      booking_date: tx.booking_date,
      amount: parseFloat(tx.transaction_amount.amount),
      currency: 'SEK',
      description: 'Test',
    }))

    mockUploadDocument.mockResolvedValue({ id: 'doc-1' })

    const account = makeAccount()
    const result = await syncAccountTransactions(
      {} as never,
      COMPANY_ID,
      USER_ID,
      CONNECTION_ID,
      account,
      '2026-02-13',
      '2026-05-13',
      mockIngest
    )

    expect(result.returnedMinBookingDate).toBe('2026-02-20')
    expect(result.returnedMaxBookingDate).toBe('2026-05-10')
  })

  it('returns undefined min/max when no transactions came back', async () => {
    mockGetAllTransactionsWithRaw.mockResolvedValue({
      transactions: [],
      rawPages: [],
    })

    const account = makeAccount()
    const result = await syncAccountTransactions(
      {} as never,
      COMPANY_ID,
      USER_ID,
      CONNECTION_ID,
      account,
      '2026-02-13',
      '2026-05-13',
      mockIngest
    )

    expect(result.returnedMinBookingDate).toBeUndefined()
    expect(result.returnedMaxBookingDate).toBeUndefined()
  })

  it('passes account.ledger_account as IngestOptions.settlementAccount when set', async () => {
    mockGetAllTransactionsWithRaw.mockResolvedValue({
      transactions: [{ transaction_amount: { amount: '100', currency: 'EUR' }, booking_date: '2026-04-01' }],
      rawPages: ['{}'],
    })
    mockConvertTransaction.mockReturnValue({
      id: 'tx-1',
      date: '2026-04-01',
      booking_date: '2026-04-01',
      amount: 100,
      currency: 'EUR',
      description: 'EUR purchase',
    })
    mockUploadDocument.mockResolvedValue({ id: 'doc-1' })

    const account = makeAccount({ uid: 'eur-acc', currency: 'EUR', ledger_account: '1932' })
    await syncAccountTransactions(
      {} as never,
      COMPANY_ID,
      USER_ID,
      CONNECTION_ID,
      account,
      '2026-02-13',
      '2026-05-13',
      mockIngest
    )

    const ingestOptions = mockIngest.mock.calls[0][4]
    expect(ingestOptions).toMatchObject({ settlementAccount: '1932' })
  })

  it('omits settlementAccount when account.ledger_account is unset (mapping engine defaults to 1930)', async () => {
    mockGetAllTransactionsWithRaw.mockResolvedValue({
      transactions: [{ transaction_amount: { amount: '100', currency: 'SEK' }, booking_date: '2026-04-01' }],
      rawPages: ['{}'],
    })
    mockConvertTransaction.mockReturnValue({
      id: 'tx-1',
      date: '2026-04-01',
      booking_date: '2026-04-01',
      amount: 100,
      currency: 'SEK',
      description: 'SEK purchase',
    })
    mockUploadDocument.mockResolvedValue({ id: 'doc-1' })

    const account = makeAccount() // No ledger_account
    await syncAccountTransactions(
      {} as never,
      COMPANY_ID,
      USER_ID,
      CONNECTION_ID,
      account,
      '2026-02-13',
      '2026-05-13',
      mockIngest
    )

    const ingestOptions = mockIngest.mock.calls[0][4]
    expect(ingestOptions.settlementAccount).toBeUndefined()
  })
})
