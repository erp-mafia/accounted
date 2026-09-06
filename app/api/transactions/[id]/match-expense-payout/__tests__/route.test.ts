import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

const mockCreatePayoutBatch = vi.fn()
vi.mock('@/lib/expenses/expense-claims-service', () => ({
  createPayoutBatch: (...args: unknown[]) => mockCreatePayoutBatch(...args),
}))

const mockResolveSettlementAccount = vi.fn()
vi.mock('@/lib/bookkeeping/settlement-account', () => ({
  resolveSettlementAccount: (...args: unknown[]) => mockResolveSettlementAccount(...args),
}))

const mockHasLiveLink = vi.fn()
vi.mock('@/lib/transactions/link-journal-entry', () => ({
  hasLiveJournalEntryLink: (...args: unknown[]) => mockHasLiveLink(...args),
}))

import { POST } from '../route'

const TX_ID = '11111111-1111-4111-8111-111111111111'
const CLAIM_A = '22222222-2222-4222-8222-222222222222'
const CLAIM_B = '33333333-3333-4333-8333-333333333333'
const mockUser = { id: 'user-1', email: 'test@test.se' }
const routeParams = createMockRouteParams({ id: TX_ID })

function makeReq(body: unknown = { claim_ids: [CLAIM_A, CLAIM_B] }) {
  return createMockRequest(`/api/transactions/${TX_ID}/match-expense-payout`, {
    method: 'POST',
    body,
  })
}

function makeTxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TX_ID,
    date: '2026-09-10',
    amount: -1596,
    currency: 'SEK',
    journal_entry_id: null,
    cash_account_id: 'ca-1',
    transaction_voucher_links: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase })
  mockResolveSettlementAccount.mockResolvedValue('1930')
  mockHasLiveLink.mockResolvedValue(false)
  mockCreatePayoutBatch.mockResolvedValue({
    ok: true,
    batch_id: 'batch-1',
    journal_entry_id: 'je-1',
    voucher_number: 12,
    total_sek: 1596,
    claim_count: 2,
  })
})

describe('POST /api/transactions/[id]/match-expense-payout', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await POST(makeReq(), routeParams)
    expect(response.status).toBe(401)
    expect(mockCreatePayoutBatch).not.toHaveBeenCalled()
  })

  it('returns 400 on an invalid body', async () => {
    const response = await POST(makeReq({ claim_ids: [] }), routeParams)
    expect(response.status).toBe(400)
    expect(mockCreatePayoutBatch).not.toHaveBeenCalled()
  })

  it('returns 404 when the transaction is not in the company', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    const response = await POST(makeReq(), routeParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('TX_CATEGORIZE_TX_NOT_FOUND')
  })

  it('refuses an income row', async () => {
    enqueue({ data: makeTxRow({ amount: 1596 }) })
    const response = await POST(makeReq(), routeParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('EXPENSE_PAYOUT_MATCH_NOT_EXPENSE')
    expect(mockCreatePayoutBatch).not.toHaveBeenCalled()
  })

  it('refuses a non-SEK row', async () => {
    enqueue({ data: makeTxRow({ currency: 'EUR' }) })
    const response = await POST(makeReq(), routeParams)
    const { body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(body.error.code).toBe('EXPENSE_PAYOUT_MATCH_CURRENCY')
  })

  it('refuses a row that is already booked (live pointer or bank_line junction)', async () => {
    enqueue({ data: makeTxRow({ journal_entry_id: 'je-old' }) })
    mockHasLiveLink.mockResolvedValue(true)
    let response = await POST(makeReq(), routeParams)
    let parsed = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(parsed.status).toBe(400)
    expect(parsed.body.error.code).toBe('EXPENSE_PAYOUT_MATCH_TX_ALREADY_LINKED')

    reset()
    mockHasLiveLink.mockResolvedValue(false)
    enqueue({
      data: makeTxRow({
        transaction_voucher_links: [{ journal_entry_id: 'je-bulk', role: 'bank_line' }],
      }),
    })
    response = await POST(makeReq(), routeParams)
    parsed = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(parsed.body.error.code).toBe('EXPENSE_PAYOUT_MATCH_TX_ALREADY_LINKED')
    expect(mockCreatePayoutBatch).not.toHaveBeenCalled()
  })

  it('books the payout from the bank row: its date, its cash account, linked in the RPC', async () => {
    enqueue({ data: makeTxRow() })
    mockResolveSettlementAccount.mockResolvedValue('1920')

    const response = await POST(makeReq(), routeParams)
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_id: string
      batch_id: string
      category: string
    }>(response)

    expect(status).toBe(200)
    expect(body).toMatchObject({
      success: true,
      journal_entry_id: 'je-1',
      batch_id: 'batch-1',
      category: 'expense_other',
    })
    expect(mockResolveSettlementAccount).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'ca-1',
      expect.anything(),
    )
    expect(mockCreatePayoutBatch).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', {
      claim_ids: [CLAIM_A, CLAIM_B],
      payout_date: '2026-09-10',
      cash_account: '1920',
      transaction_id: TX_ID,
    })
  })

  it('maps an amount mismatch onto the structured envelope', async () => {
    enqueue({ data: makeTxRow() })
    mockCreatePayoutBatch.mockResolvedValue({ ok: false, code: 'TX_AMOUNT_MISMATCH' })
    const response = await POST(makeReq(), routeParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('EXPENSE_PAYOUT_MATCH_AMOUNT')
  })

  it('maps service refusals onto their user-facing message and status', async () => {
    enqueue({ data: makeTxRow() })
    mockCreatePayoutBatch.mockResolvedValue({ ok: false, code: 'ALREADY_PAID' })
    const response = await POST(makeReq(), routeParams)
    const { status, body } = await parseJsonResponse<{ error: string; code: string }>(response)
    expect(status).toBe(409)
    expect(body.code).toBe('ALREADY_PAID')
    expect(body.error).toContain('redan utbetalt')
  })
})
