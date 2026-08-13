import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeTransaction,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

// PATCH goes through withRouteContext → requireAuth.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: vi.fn(),
}))

vi.mock('@/lib/sandbox/guard', () => ({
  guardSandbox: vi.fn(),
}))

import { PATCH } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { guardSandbox } from '@/lib/sandbox/guard'
import { NextResponse } from 'next/server'

describe('PATCH /api/transactions/[id]/cash-account (move cash account)', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  function patchReq(body: unknown) {
    return new Request('http://localhost/api/transactions/tx-1/cash-account', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  /** A movable staging row: unbooked, unmatched. */
  function movableTx(overrides: Record<string, unknown> = {}) {
    return makeTransaction({
      id: 'tx-1',
      journal_entry_id: null,
      invoice_id: null,
      supplier_invoice_id: null,
      cash_account_id: 'ca-1',
      currency: 'SEK',
      ...overrides,
    })
  }

  const targetAccount = { id: 'ca-2', ledger_account: '1931', currency: 'SEK' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    vi.mocked(requireAuth).mockResolvedValue({
      user: mockUser as never,
      supabase: mockSupabase as never,
      error: null,
    })
    vi.mocked(guardSandbox).mockResolvedValue(null)
  })

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null as never,
      supabase: mockSupabase as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const res = await PATCH(patchReq({ account_number: '1931' }), createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it.each(['4000', '193', '19301', 'abcd', ''])(
    'returns 400 for a non-19xx account_number (%s)',
    async (accountNumber) => {
      const res = await PATCH(
        patchReq({ account_number: accountNumber }),
        createMockRouteParams({ id: 'tx-1' }),
      )
      const { status } = await parseJsonResponse(res)
      expect(status).toBe(400)
    },
  )

  it('returns 400 when account_number is missing', async () => {
    const res = await PATCH(patchReq({}), createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })

  it('returns 404 when the transaction is not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } }) // tx fetch

    const res = await PATCH(patchReq({ account_number: '1931' }), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(404)
    expect(body.error.code).toBe('TX_CATEGORIZE_TX_NOT_FOUND')
  })

  it('returns 409 when the transaction is booked (journal_entry_id set)', async () => {
    enqueue({ data: movableTx({ journal_entry_id: 'je-1' }), error: null }) // tx fetch

    const res = await PATCH(patchReq({ account_number: '1931' }), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(409)
    expect(body.error.code).toBe('TRANSACTION_MOVE_BOOKED')
  })

  it('returns 409 when matched to an invoice even if journal_entry_id is null', async () => {
    enqueue({ data: movableTx({ invoice_id: 'inv-1' }), error: null }) // tx fetch

    const res = await PATCH(patchReq({ account_number: '1931' }), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(409)
    expect(body.error.code).toBe('TRANSACTION_MOVE_BOOKED')
  })

  it('returns 409 when matched to a supplier invoice even if journal_entry_id is null', async () => {
    enqueue({ data: movableTx({ supplier_invoice_id: 'si-1' }), error: null }) // tx fetch

    const res = await PATCH(patchReq({ account_number: '1931' }), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(409)
    expect(body.error.code).toBe('TRANSACTION_MOVE_BOOKED')
  })

  it('returns 409 when anchored via transaction_voucher_links (bulk-book N>1)', async () => {
    enqueue({ data: movableTx(), error: null }) // tx fetch passes the field gate
    enqueue({ data: [{ transaction_id: 'tx-1' }], error: null }) // tvl pre-check hits

    const res = await PATCH(patchReq({ account_number: '1931' }), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(409)
    expect(body.error.code).toBe('TRANSACTION_MOVE_BOOKED')
  })

  it('returns 404 when the account is not one of the company cash accounts', async () => {
    enqueue({ data: movableTx(), error: null }) // tx fetch
    enqueue({ data: [], error: null }) // tvl pre-check clean
    enqueue({ data: null, error: null }) // cash account lookup misses

    const res = await PATCH(patchReq({ account_number: '1959' }), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(404)
    expect(body.error.code).toBe('TRANSACTION_MOVE_UNKNOWN_ACCOUNT')
  })

  it('returns 400 when the transaction currency does not match the target account', async () => {
    enqueue({ data: movableTx({ currency: 'EUR' }), error: null }) // tx fetch
    enqueue({ data: [], error: null }) // tvl pre-check clean
    enqueue({ data: targetAccount, error: null }) // SEK account

    const res = await PATCH(patchReq({ account_number: '1931' }), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('TRANSACTION_MOVE_CURRENCY_MISMATCH')
  })

  it('moves a movable transaction to the target account', async () => {
    enqueue({ data: movableTx(), error: null }) // tx fetch
    enqueue({ data: [], error: null }) // tvl pre-check clean
    enqueue({ data: targetAccount, error: null }) // account lookup
    enqueue({ data: { id: 'tx-1', cash_account_id: 'ca-2' }, error: null }) // update

    const res = await PATCH(patchReq({ account_number: '1931' }), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ data: { id: string; cash_account_id: string } }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual({ id: 'tx-1', cash_account_id: 'ca-2' })
  })

  it('returns 409 when the row is booked between read and write (optimistic-lock miss)', async () => {
    enqueue({ data: movableTx(), error: null }) // tx fetch passes the read gate
    enqueue({ data: [], error: null }) // tvl pre-check clean
    enqueue({ data: targetAccount, error: null }) // account lookup
    enqueue({ data: null, error: null }) // UPDATE affects 0 rows (gate re-assert failed)

    const res = await PATCH(patchReq({ account_number: '1931' }), createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(409)
    expect(body.error.code).toBe('TRANSACTION_MOVE_BOOKED')
  })
})
