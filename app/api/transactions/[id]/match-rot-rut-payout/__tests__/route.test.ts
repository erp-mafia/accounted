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

const mockSettle = vi.fn()
vi.mock('@/lib/invoices/rot-rut-settle', () => ({
  settleRotRutPayoutRequest: (...args: unknown[]) => mockSettle(...args),
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
const REQUEST_ID = '22222222-2222-4222-8222-222222222222'
const mockUser = { id: 'user-1', email: 'test@test.se' }
const routeParams = createMockRouteParams({ id: TX_ID })

function makeReq(body: unknown = { request_id: REQUEST_ID }) {
  return createMockRequest(`/api/transactions/${TX_ID}/match-rot-rut-payout`, {
    method: 'POST',
    body,
  })
}

function makeTxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TX_ID,
    date: '2026-07-10',
    amount: 3000,
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
  mockSettle.mockResolvedValue({
    ok: true,
    journalEntryId: 'je-1',
    amount: 3000,
    fullyPaid: true,
    request: { id: REQUEST_ID, name: 'ROT 2026-07', status: 'paid' },
  })
})

describe('POST /api/transactions/[id]/match-rot-rut-payout', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await POST(makeReq(), routeParams)
    expect(response.status).toBe(401)
    expect(mockSettle).not.toHaveBeenCalled()
  })

  it('returns 400 on an invalid body', async () => {
    const response = await POST(makeReq({ request_id: 'not-a-uuid' }), routeParams)
    expect(response.status).toBe(400)
    expect(mockSettle).not.toHaveBeenCalled()
  })

  it('returns 404 when the transaction is not in the company', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    const response = await POST(makeReq(), routeParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('TX_CATEGORIZE_TX_NOT_FOUND')
  })

  it('refuses an expense row', async () => {
    enqueue({ data: makeTxRow({ amount: -3000 }) })
    const response = await POST(makeReq(), routeParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('ROT_RUT_MATCH_NOT_INCOME')
    expect(mockSettle).not.toHaveBeenCalled()
  })

  it('refuses a non-SEK row', async () => {
    enqueue({ data: makeTxRow({ currency: 'EUR' }) })
    const response = await POST(makeReq(), routeParams)
    const { body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(body.error.code).toBe('ROT_RUT_MATCH_CURRENCY')
  })

  it('refuses a row that is already booked (live pointer or bank_line junction)', async () => {
    enqueue({ data: makeTxRow({ journal_entry_id: 'je-old' }) })
    mockHasLiveLink.mockResolvedValue(true)
    let response = await POST(makeReq(), routeParams)
    let parsed = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(parsed.status).toBe(400)
    expect(parsed.body.error.code).toBe('ROT_RUT_MATCH_TX_ALREADY_LINKED')

    reset()
    enqueue({
      data: makeTxRow({
        transaction_voucher_links: [{ journal_entry_id: 'je-bulk', role: 'bank_line' }],
      }),
    })
    response = await POST(makeReq(), routeParams)
    parsed = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(parsed.body.error.code).toBe('ROT_RUT_MATCH_TX_ALREADY_LINKED')
    expect(mockSettle).not.toHaveBeenCalled()
  })

  it('settles the request with the transaction amount, date and cash account, linking the row', async () => {
    enqueue({ data: makeTxRow() })
    mockResolveSettlementAccount.mockResolvedValue('1920')

    const response = await POST(makeReq(), routeParams)
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_id: string
      request: { status: string }
      category: string
    }>(response)

    expect(status).toBe(200)
    expect(body).toMatchObject({
      success: true,
      journal_entry_id: 'je-1',
      request: { status: 'paid' },
      category: 'income_other',
    })
    expect(mockResolveSettlementAccount).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'ca-1',
      expect.anything(),
    )
    expect(mockSettle).toHaveBeenCalledWith(expect.anything(), 'user-1', 'company-1', {
      requestId: REQUEST_ID,
      paymentDate: '2026-07-10',
      amount: 3000,
      bankAccount: '1920',
      transactionId: TX_ID,
      previousJournalEntryId: null,
    })
  })

  it('forwards a stale (non-live) pointer so the link CAS locks on it', async () => {
    enqueue({ data: makeTxRow({ journal_entry_id: 'je-reversed' }) })
    mockHasLiveLink.mockResolvedValue(false)
    const response = await POST(makeReq(), routeParams)
    expect(response.status).toBe(200)
    expect(mockSettle).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'company-1',
      expect.objectContaining({ previousJournalEntryId: 'je-reversed' }),
    )
  })

  it('maps service error codes onto the canonical envelope', async () => {
    enqueue({ data: makeTxRow() })
    mockSettle.mockResolvedValue({
      ok: false,
      kind: 'code',
      code: 'ROT_RUT_SETTLE_INVALID_STATE',
      details: { status: 'submitted', reason: 'beslut saknas' },
    })
    const response = await POST(makeReq(), routeParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('ROT_RUT_SETTLE_INVALID_STATE')

    reset()
    enqueue({ data: makeTxRow() })
    mockSettle.mockResolvedValue({
      ok: false,
      kind: 'code',
      code: 'ROT_RUT_MATCH_TX_LINK_FAILED',
      details: { journal_entry_id: 'je-1', request_id: REQUEST_ID },
    })
    const conflict = await POST(makeReq(), routeParams)
    expect(conflict.status).toBe(409)
  })
})
