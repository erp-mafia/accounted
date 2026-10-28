/**
 * An approved gnubok_create_transactions row goes through the shared ingest
 * pipeline, not a raw insert of its own.
 *
 * ingestTransactions is what every other door that stores a bank row runs
 * (the PSD2 sync, the bank-file import, v1 POST /transactions/ingest): the
 * external_id and content dedup against rows a feed or an import already
 * stored, the invoice / supplier-invoice / payment-order / ROT-RUT
 * suggestions and the collections sweep. The executor kept a raw insert from
 * before ingest was shared, so a movement the bank feed had already stored was
 * inserted a second time when an agent typed it, and the row got none of the
 * suggestions. The executor keeps what only it does: the argument checks, the
 * refusal of a foreign row whose rate cannot be had while the approver is
 * present, and the manual kassakonto for ledger_account.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/transactions/ingest', async () => {
  const actual = await vi.importActual<typeof import('@/lib/transactions/ingest')>('@/lib/transactions/ingest')
  return { ...actual, ingestTransactions: vi.fn() }
})

vi.mock('@/lib/currency/riksbanken', async () => {
  const actual = await vi.importActual<typeof import('@/lib/currency/riksbanken')>('@/lib/currency/riksbanken')
  return {
    ...actual,
    fetchExchangeRate: vi.fn(),
    isExchangeRateTemporarilyUnavailable: vi.fn(() => false),
  }
})

vi.mock('@/lib/cash-accounts/service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/cash-accounts/service')>('@/lib/cash-accounts/service')
  return { ...actual, ensureManualCashAccount: vi.fn(async () => 'ca-1935') }
})

import { commitPendingOperation } from '../commit'
import { ingestTransactions } from '@/lib/transactions/ingest'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { ensureManualCashAccount } from '@/lib/cash-accounts/service'

const mockIngest = vi.mocked(ingestTransactions)

function makePendingOp(params: Record<string, unknown>): PendingOperation {
  return {
    id: 'op-7f3a',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'create_transaction',
    status: 'pending',
    title: 'Ny transaktion',
    params,
    preview_data: params,
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    created_at: '2026-10-13T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-10-13T00:00:00Z',
  } as PendingOperation
}

function ingestResult(overrides: Record<string, unknown> = {}) {
  return {
    imported: 1,
    duplicates: 0,
    duplicates_by_reason: { external_id_match: 0, content_match_booked: 0, content_match_unbooked: 0 },
    skipped: [],
    reconciled: 0,
    auto_categorized: 0,
    auto_matched_invoices: 0,
    errors: 0,
    transaction_ids: ['tx-42'],
    ...overrides,
  }
}

/**
 * CAS claim, the default cash account lookup when the row names no
 * ledger_account (crm#1171), then the dispatcher's status update: ingest
 * itself is mocked.
 */
function claimedSupabase(cashAccounts: { data: unknown; error: unknown } | null = { data: [], error: null }) {
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: { id: 'op-7f3a' }, error: null })
  if (cashAccounts) enqueue(cashAccounts)
  enqueue({ data: null, error: null })
  return supabase
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: create_transaction through ingestTransactions', () => {
  it('stores the row through ingest with the staged fields, import_source mcp and no auto-booking', async () => {
    mockIngest.mockResolvedValueOnce(ingestResult() as never)
    const supabase = claimedSupabase()

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        date: '2026-10-01',
        amount: -129.5,
        description: 'AWS subscription',
        currency: 'SEK',
        ledger_account: null,
        bank_connection_id: null,
        external_id: 'recAirtable123',
      }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ transaction_id: 'tx-42' })
    expect(mockIngest).toHaveBeenCalledTimes(1)
    const [client, companyId, userId, rows, options] = mockIngest.mock.calls[0]
    expect(client).toBe(supabase)
    expect(companyId).toBe('company-1')
    expect(userId).toBe('user-1')
    expect(rows).toEqual([
      {
        date: '2026-10-01',
        description: 'AWS subscription',
        amount: -129.5,
        currency: 'SEK',
        external_id: 'recAirtable123',
        import_source: 'mcp',
        bank_connection_id: null,
      },
    ])
    expect(options).toEqual({ settlementAccount: undefined, skipAutoCategorization: true })
  })

  it('a row staged without external_id (the old params shape) gets mcp:<operation id>', async () => {
    mockIngest.mockResolvedValueOnce(ingestResult() as never)

    const result = await commitPendingOperation(
      claimedSupabase() as never,
      'user-1',
      'company-1',
      // Exactly what the staging wrote before this change.
      makePendingOp({ date: '2026-10-01', amount: 100, description: 'Swish in', currency: 'SEK' }),
    )

    expect(result.status).toBe('committed')
    expect(mockIngest.mock.calls[0][3][0]).toMatchObject({ external_id: 'mcp:op-7f3a', import_source: 'mcp' })
  })

  it('binds the manual kassakonto for ledger_account and settles the batch on it', async () => {
    mockIngest.mockResolvedValueOnce(ingestResult() as never)

    const result = await commitPendingOperation(
      claimedSupabase(null) as never,
      'user-1',
      'company-1',
      makePendingOp({ date: '2026-10-01', amount: -200, description: 'WISE KORT', currency: 'SEK', ledger_account: '1935' }),
    )

    expect(result.status).toBe('committed')
    expect(ensureManualCashAccount).toHaveBeenCalledWith(expect.anything(), 'company-1', '1935', 'SEK')
    expect(mockIngest.mock.calls[0][4]).toEqual({ settlementAccount: '1935', skipAutoCategorization: true })
    expect(result.data).toMatchObject({ transaction_id: 'tx-42', cash_account_id: 'ca-1935' })
  })

  describe('ledger_account on a company card', () => {
    async function commitOnCard(card: unknown, params: Record<string, unknown> = {}) {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: { id: 'op-7f3a' }, error: null }) // CAS claim
      enqueue({ data: card, error: null }) // the card on that ledger
      enqueue({ data: null, error: null }) // dispatcher's update
      const result = await commitPendingOperation(
        supabase as never,
        'user-1',
        'company-1',
        makePendingOp({ date: '2026-10-01', amount: -349, description: 'Molnkontoret AB', currency: 'SEK', ledger_account: '2890', ...params }),
      )
      return { result, lookupEqs: findCalls('cash_accounts', 'eq') }
    }

    it('binds the row to the existing card and never creates an account', async () => {
      mockIngest.mockResolvedValueOnce(ingestResult() as never)
      const { result, lookupEqs } = await commitOnCard({ id: 'card-1', currency: 'SEK', enabled: true, name: 'Eurocard' })
      expect(result.status).toBe('committed')
      expect(ensureManualCashAccount).not.toHaveBeenCalled()
      expect(mockIngest.mock.calls.at(-1)?.[4]).toEqual({ settlementAccount: '2890', skipAutoCategorization: true })
      expect(lookupEqs).toContainEqual(['kind', 'card'])
    })

    it('refuses a card ledger no card of the company books on', async () => {
      const { result } = await commitOnCard(null)
      expect(result.status).not.toBe('committed')
      expect(ensureManualCashAccount).not.toHaveBeenCalled()
      expect(mockIngest).not.toHaveBeenCalled()
    })
  })

  // crm#1171: a row staged without ledger_account was stored with
  // cash_account_id NULL, while every bank-feed and bank-file row is bound.
  // Ingest binds a batch by its settlement account's ledger number.
  describe('without ledger_account: the default account in the row currency (crm#1171)', () => {
    async function commitWith(cashAccounts: { data: unknown; error: unknown }, params: Record<string, unknown> = {}) {
      mockIngest.mockResolvedValueOnce(ingestResult() as never)
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: { id: 'op-7f3a' }, error: null }) // CAS claim
      enqueue(cashAccounts) // default cash account lookup
      enqueue({ data: null, error: null }) // dispatcher's update
      const result = await commitPendingOperation(
        supabase as never,
        'user-1',
        'company-1',
        makePendingOp({ date: '2026-10-01', amount: -99, description: 'Kortköp', currency: 'SEK', ...params }),
      )
      const options = mockIngest.mock.calls.at(-1)?.[4]
      return { result, settlementAccount: options?.settlementAccount, lookupEqs: findCalls('cash_accounts', 'eq') }
    }

    it('settles on the only enabled account in that currency', async () => {
      const { result, settlementAccount } = await commitWith({
        data: [{ id: 'ca-1935', ledger_account: '1935', is_primary: false, bank_connection_id: null }],
        error: null,
      })
      expect(result.status).toBe('committed')
      expect(settlementAccount).toBe('1935')
      expect(result.data).toMatchObject({ transaction_id: 'tx-42', cash_account_id: 'ca-1935' })
    })

    it('settles on the primary when the company has several enabled accounts in that currency', async () => {
      const { result, settlementAccount, lookupEqs } = await commitWith({
        data: [
          { id: 'ca-1686', ledger_account: '1686', is_primary: false, bank_connection_id: null },
          { id: 'ca-1930', ledger_account: '1930', is_primary: true, bank_connection_id: 'bc-1' },
        ],
        error: null,
      })
      expect(result.status).toBe('committed')
      expect(settlementAccount).toBe('1930')
      expect(result.data).toMatchObject({ cash_account_id: 'ca-1930' })
      // Only the company's own enabled accounts in the row's currency.
      expect(lookupEqs).toEqual([['company_id', 'company-1'], ['enabled', true], ['kind', 'bank'], ['currency', 'SEK']])
    })

    it('settles only on an account of the given bank connection, never another bank', async () => {
      const bound = await commitWith(
        {
          data: [
            { id: 'ca-primary', ledger_account: '1930', is_primary: true, bank_connection_id: 'bc-1' },
            { id: 'ca-other-bank', ledger_account: '1931', is_primary: false, bank_connection_id: 'bc-2' },
          ],
          error: null,
        },
        { bank_connection_id: 'bc-2' },
      )
      expect(bound.settlementAccount).toBe('1931')

      const ambiguous = await commitWith(
        {
          data: [
            { id: 'ca-primary', ledger_account: '1930', is_primary: true, bank_connection_id: 'bc-1' },
            { id: 'ca-a', ledger_account: '1931', is_primary: false, bank_connection_id: 'bc-2' },
            { id: 'ca-b', ledger_account: '1932', is_primary: false, bank_connection_id: 'bc-2' },
          ],
          error: null,
        },
        { bank_connection_id: 'bc-2' },
      )
      expect(ambiguous.result.status).toBe('committed')
      expect(ambiguous.settlementAccount).toBeUndefined()
      expect(ambiguous.result.data).toMatchObject({ cash_account_id: null })
    })

    it('leaves the row unassigned, and still stores it, when the lookup fails', async () => {
      const { result, settlementAccount } = await commitWith({ data: null, error: { message: 'timeout' } })
      expect(result.status).toBe('committed')
      expect(settlementAccount).toBeUndefined()
    })
  })

  it('409 TX_CREATE_DUPLICATE naming the stored row when ingest finds the movement already stored', async () => {
    mockIngest.mockResolvedValueOnce(
      ingestResult({
        imported: 0,
        duplicates: 1,
        transaction_ids: [],
        skipped: [
          {
            external_id: 'mcp:op-7f3a',
            reason: 'content_match_unbooked',
            matched_external_id: 'eb-123',
            matched_transaction_id: 'tx-feed-9',
          },
        ],
      }) as never,
    )

    const result = await commitPendingOperation(
      claimedSupabase() as never,
      'user-1',
      'company-1',
      makePendingOp({ date: '2026-10-01', amount: -129.5, description: 'AWS', currency: 'SEK' }),
    )

    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
    expect(result.code).toBe('TX_CREATE_DUPLICATE')
    expect(result.error).toMatch(/tx-feed-9/)
  })

  it('keeps refusing a foreign row whose rate cannot be had, before any kassakonto or ingest', async () => {
    vi.mocked(fetchExchangeRate).mockResolvedValueOnce(null)

    const result = await commitPendingOperation(
      claimedSupabase(null) as never,
      'user-1',
      'company-1',
      makePendingOp({ date: '2026-10-01', amount: -50, description: 'Wise card', currency: 'USD', ledger_account: '1935' }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/1 USD = 1 SEK/)
    expect(ensureManualCashAccount).not.toHaveBeenCalled()
    expect(mockIngest).not.toHaveBeenCalled()
  })

  it('a foreign row with a rate goes to ingest, which reads the cached rate', async () => {
    vi.mocked(fetchExchangeRate).mockResolvedValueOnce({ currency: 'USD', rate: 10.5, date: '2026-10-01' } as never)
    mockIngest.mockResolvedValueOnce(ingestResult() as never)

    const result = await commitPendingOperation(
      claimedSupabase() as never,
      'user-1',
      'company-1',
      makePendingOp({ date: '2026-10-01', amount: 1500, description: 'Stripe payout', currency: 'USD' }),
    )

    expect(result.status).toBe('committed')
    expect(mockIngest.mock.calls[0][3][0]).toMatchObject({ amount: 1500, currency: 'USD' })
  })

  it('500 with the database message when ingest could not insert the row', async () => {
    mockIngest.mockResolvedValueOnce(
      ingestResult({ imported: 0, errors: 1, transaction_ids: [], first_error: { message: 'insert failed', code: 'XX000' } }) as never,
    )

    const result = await commitPendingOperation(
      claimedSupabase() as never,
      'user-1',
      'company-1',
      makePendingOp({ date: '2026-10-01', amount: 1, description: 'x', currency: 'SEK' }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(500)
  })
})
