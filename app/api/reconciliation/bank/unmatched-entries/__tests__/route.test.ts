/**
 * Tests for GET /api/reconciliation/bank/unmatched-entries.
 *
 * Exercises the route through the real withRouteContext wrapper and the REAL
 * matcher (tryReconcileTransaction / ledgerLineAmountIn); only the RPC-backed
 * candidate fetch is mocked, so the currency guard is tested end to end rather
 * than against a stubbed scorer.
 *
 * The focus is the ranking currency: it is the CASH ACCOUNT's, never the
 * transaction's own. Sourcing it from the transaction made
 * tryReconcileTransaction's `transaction.currency !== expectedCurrency` guard
 * compare the transaction against itself, so it never rejected anything and a
 * foreign bank line was ranked against this account's SEK vouchers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { GLLineForMatching } from '@/lib/reconciliation/bank-reconciliation'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

// Only the candidate fetch is stubbed: the scorer and ledgerLineAmountIn stay
// real so a regression in the currency handling actually fails here.
const fetchGLLinesForMatchingMock = vi.fn()
vi.mock('@/lib/reconciliation/bank-reconciliation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reconciliation/bank-reconciliation')>()
  return {
    ...actual,
    fetchGLLinesForMatching: (...args: unknown[]) => fetchGLLinesForMatchingMock(...args),
  }
})

import { GET } from '../route'

const emptyParams = { params: Promise.resolve({}) }
const TX_ID = '11111111-1111-4111-8111-111111111111'

type RankedLine = GLLineForMatching & { confidence: number }
type Body = { data: RankedLine[]; not_rankable_reason?: string }

function makeGLLine(overrides: Partial<GLLineForMatching> = {}): GLLineForMatching {
  return {
    line_id: 'line-1',
    journal_entry_id: 'je-1',
    // The RPC projects the SEK debit/credit columns only: see the currency /
    // amount_in_currency note on UnlinkedGLLine.
    debit_amount: 0,
    credit_amount: 1150,
    line_description: null,
    entry_date: '2026-03-10',
    voucher_number: 42,
    voucher_series: 'A',
    entry_description: 'Leverantörsbetalning',
    source_type: 'manual',
    linked_transaction_count: 0,
    ...overrides,
  }
}

/** Queue the cash_accounts lookup the route always performs first. */
function enqueueCashAccount(currency: string | null = 'SEK') {
  enqueue({ data: { id: 'cash-1', currency } })
}

/** Queue the transaction lookup the ranked path performs second. */
function enqueueTransaction(overrides: Record<string, unknown> = {}) {
  enqueue({
    data: {
      id: TX_ID,
      amount: -1150,
      date: '2026-03-10',
      currency: 'SEK',
      reference: null,
      ...overrides,
    },
  })
}

function request(searchParams: Record<string, string>) {
  return createMockRequest('/api/reconciliation/bank/unmatched-entries', { searchParams })
}

describe('GET /api/reconciliation/bank/unmatched-entries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    fetchGLLinesForMatchingMock.mockResolvedValue([])
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(request({ account_number: '1930' }), emptyParams)

    expect(response.status).toBe(401)
    expect(fetchGLLinesForMatchingMock).not.toHaveBeenCalled()
  })

  it('rejects an account the company has not registered as a cash account', async () => {
    // The route's "not found": an unregistered ledger account is refused rather
    // than probed, so this endpoint cannot be used to read arbitrary GL accounts.
    enqueue({ data: null })

    const response = await GET(request({ account_number: '1510' }), emptyParams)

    expect(response.status).toBe(400)
    expect(fetchGLLinesForMatchingMock).not.toHaveBeenCalled()
  })

  it('returns no candidates when transaction_id does not resolve in this company', async () => {
    enqueueCashAccount('SEK')
    enqueue({ data: null })
    fetchGLLinesForMatchingMock.mockResolvedValue([makeGLLine()])

    const response = await GET(
      request({ account_number: '1930', transaction_id: TX_ID }),
      emptyParams,
    )
    const { status, body } = await parseJsonResponse<Body>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual([])
  })

  // ----------------------------------------------------------------
  // SEK: the 95% path, byte-for-byte unchanged
  // ----------------------------------------------------------------

  it('ranks a SEK bank line against SEK vouchers exactly as before', async () => {
    enqueueCashAccount('SEK')
    enqueueTransaction({ currency: 'SEK', amount: -1150, date: '2026-03-10' })
    fetchGLLinesForMatchingMock.mockResolvedValue([
      makeGLLine({ line_id: 'line-far', journal_entry_id: 'je-far', entry_date: '2026-02-01' }),
      makeGLLine({ line_id: 'line-hit', journal_entry_id: 'je-hit', entry_date: '2026-03-10' }),
    ])

    const response = await GET(
      request({ account_number: '1930', transaction_id: TX_ID }),
      emptyParams,
    )
    const { status, body } = await parseJsonResponse<Body>(response)

    expect(status).toBe(200)
    // Nothing withheld on a SEK account: ledgerLineAmountIn never returns null there.
    expect(body.data).toHaveLength(2)
    expect(body.not_rankable_reason).toBeUndefined()
    // Exact amount + exact date = auto_exact, sorted to the top.
    expect(body.data[0].journal_entry_id).toBe('je-hit')
    expect(body.data[0].confidence).toBe(0.95)
    expect(body.data[1].confidence).toBe(0)
  })

  it('leaves the unranked list untouched when no transaction_id is passed', async () => {
    enqueueCashAccount('SEK')
    const lines = [makeGLLine()]
    fetchGLLinesForMatchingMock.mockResolvedValue(lines)

    const response = await GET(request({ account_number: '1930' }), emptyParams)
    const { status, body } = await parseJsonResponse<Body>(response)

    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).not.toHaveProperty('confidence')
  })

  // ----------------------------------------------------------------
  // Orphaned reconnect rows (#1643 problem 1): the ranked (dialog) path also
  // offers vouchers booked on sibling ledgers of the same physical account
  // ----------------------------------------------------------------

  it('widens ranked candidates to sibling ledgers sharing the account IBAN', async () => {
    const iban = 'SE4550000000058398257466'
    // The transaction's own (orphaned) row: ledger 1931, carries the IBAN.
    enqueue({ data: { id: 'cash-orphan', currency: 'SEK', iban } })
    // Sibling scan: the live row for the same physical account sits on 1940
    // (spaced IBAN variant to prove normalization), plus an unrelated account.
    enqueue({
      data: [
        { ledger_account: '1931', iban },
        { ledger_account: '1940', iban: 'SE45 5000 0000 0583 9825 7466' },
        { ledger_account: '1935', iban: 'SE1112223334445556667778' },
      ],
    })
    enqueueTransaction({ currency: 'SEK', amount: 217.04, date: '2026-03-10' })

    fetchGLLinesForMatchingMock.mockImplementation((_supabase, _companyId, account) =>
      account === '1940'
        ? Promise.resolve([
            makeGLLine({
              line_id: 'line-live',
              journal_entry_id: 'je-live',
              debit_amount: 217.04,
              credit_amount: 0,
              entry_date: '2026-03-10',
            }),
          ])
        : Promise.resolve([]),
    )

    const response = await GET(
      request({ account_number: '1931', transaction_id: TX_ID }),
      emptyParams,
    )
    const { status, body } = await parseJsonResponse<Body>(response)

    expect(status).toBe(200)
    // The voucher booked on the LIVE ledger is offered (and ranks as an exact
    // hit) even though the row itself is stamped on the orphaned 1931.
    expect(body.data).toHaveLength(1)
    expect(body.data[0].journal_entry_id).toBe('je-live')
    expect(body.data[0].confidence).toBe(0.95)

    const fetchedAccounts = fetchGLLinesForMatchingMock.mock.calls.map((c) => c[2])
    expect(fetchedAccounts).toEqual(['1931', '1940'])
  })

  it('does not widen the unranked (reconciliation view) path', async () => {
    const iban = 'SE4550000000058398257466'
    enqueue({ data: { id: 'cash-orphan', currency: 'SEK', iban } })
    fetchGLLinesForMatchingMock.mockResolvedValue([makeGLLine()])

    const response = await GET(request({ account_number: '1931' }), emptyParams)
    const { status } = await parseJsonResponse<Body>(response)

    expect(status).toBe(200)
    expect(fetchGLLinesForMatchingMock).toHaveBeenCalledTimes(1)
    expect(fetchGLLinesForMatchingMock.mock.calls[0][2]).toBe('1931')
  })

  // ----------------------------------------------------------------
  // Foreign currency: never ranked against an unconverted SEK ledger leg
  // ----------------------------------------------------------------

  it('does not rank a foreign bank line against a same-magnitude SEK voucher', async () => {
    // A 1 150 EUR payment out of the EUR account. The voucher's 1932 leg holds
    // 1 150 in the SEK columns for an unrelated amount of money; the RPC
    // projects no currency / amount_in_currency, so there is no rate to convert
    // with. Offering it as the settlement would be a coincidence of magnitude.
    enqueueCashAccount('EUR')
    enqueueTransaction({ currency: 'EUR', amount: -1150, date: '2026-03-10' })
    fetchGLLinesForMatchingMock.mockResolvedValue([makeGLLine({ credit_amount: 1150 })])

    const response = await GET(
      request({ account_number: '1932', transaction_id: TX_ID }),
      emptyParams,
    )
    const { status, body } = await parseJsonResponse<Body>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual([])
    // Honest about WHY the list is empty: candidates exist, they just cannot be
    // expressed in the account's currency. Not "no unmatched verifikationer".
    expect(body.not_rankable_reason).toBe('gl_lines_missing_currency_amount')
  })

  it('refuses to rank a bank line denominated in another currency than the account', async () => {
    // The tautology this fixes: with the reconciliation currency read off the
    // transaction, this EUR row was ranked against the SEK account's vouchers.
    enqueueCashAccount('SEK')
    enqueueTransaction({ currency: 'EUR', amount: -1150, date: '2026-03-10' })
    fetchGLLinesForMatchingMock.mockResolvedValue([makeGLLine({ credit_amount: 1150 })])

    const response = await GET(
      request({ account_number: '1930', transaction_id: TX_ID }),
      emptyParams,
    )
    const { status, body } = await parseJsonResponse<Body>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual([])
    expect(body.not_rankable_reason).toBe('transaction_currency_mismatch')
  })

  it('ranks a foreign bank line when the ledger line carries a foreign amount', async () => {
    // Proves the filter is per-line, not a blanket "non-SEK account cannot
    // rank": the day the RPC projects currency + amount_in_currency, ranking
    // resumes with no further change here.
    enqueueCashAccount('EUR')
    enqueueTransaction({ currency: 'EUR', amount: -100, date: '2026-03-10' })
    fetchGLLinesForMatchingMock.mockResolvedValue([
      makeGLLine({
        // Debit/credit are SEK; the EUR figure lives in amount_in_currency.
        credit_amount: 1150,
        currency: 'EUR',
        amount_in_currency: 100,
      }),
    ])

    const response = await GET(
      request({ account_number: '1932', transaction_id: TX_ID }),
      emptyParams,
    )
    const { status, body } = await parseJsonResponse<Body>(response)

    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].confidence).toBe(0.95)
    expect(body.not_rankable_reason).toBeUndefined()
  })
})
