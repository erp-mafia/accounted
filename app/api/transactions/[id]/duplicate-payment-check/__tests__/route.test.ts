import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const { mockDetectOne, mockDetectSet } = vi.hoisted(() => ({
  mockDetectOne: vi.fn(),
  mockDetectSet: vi.fn(),
}))
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectDuplicatePaymentVoucher: mockDetectOne,
  detectExplainingVoucherSetForTransaction: mockDetectSet,
}))

import { GET } from '../route'

const TX_UUID = '11111111-1111-4111-8111-111111111111'

describe('GET /api/transactions/[id]/duplicate-payment-check', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 't@t.se' } } })
    mockDetectOne.mockResolvedValue(null)
    mockDetectSet.mockResolvedValue(null)
  })

  it('returns 401 when unauthenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await GET(
      createMockRequest(`/api/transactions/${TX_UUID}/duplicate-payment-check`),
      createMockRouteParams({ id: TX_UUID }),
    )
    expect(response.status).toBe(401)
  })

  it('returns 404 when the transaction is not in the company', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    const response = await GET(
      createMockRequest(`/api/transactions/${TX_UUID}/duplicate-payment-check`),
      createMockRouteParams({ id: TX_UUID }),
    )
    expect(response.status).toBe(404)
  })

  it('returns both nulls for a row that is already linked, without detecting', async () => {
    enqueue({ data: { id: TX_UUID, date: '2026-07-31', amount: 100, currency: 'SEK', journal_entry_id: 'je-live' }, error: null })
    const response = await GET(
      createMockRequest(`/api/transactions/${TX_UUID}/duplicate-payment-check`),
      createMockRouteParams({ id: TX_UUID }),
    )
    const { status, body } = await parseJsonResponse<{ candidate: unknown; candidate_set: unknown }>(response)
    expect(status).toBe(200)
    expect(body).toEqual({ candidate: null, candidate_set: null })
    expect(mockDetectOne).not.toHaveBeenCalled()
    expect(mockDetectSet).not.toHaveBeenCalled()
  })

  it('returns the 1:1 candidate and the explaining set side by side', async () => {
    enqueue({
      data: { id: TX_UUID, date: '2026-07-31', amount: 88250, currency: 'SEK', amount_sek: null, exchange_rate: null, journal_entry_id: null, cash_account_id: 'ca-1' },
      error: null,
    })
    const set = {
      vouchers: [{ journal_entry_id: 'je-a', voucher_label: 'A57', entry_date: '2026-07-31', description: null, source_type: 'invoice_paid', amount: 62500, bank_account_number: '1930' }],
      total: 62500,
      bank_account_number: '1930',
      same_date: true,
    }
    mockDetectSet.mockResolvedValue(set)

    const response = await GET(
      createMockRequest(`/api/transactions/${TX_UUID}/duplicate-payment-check`),
      createMockRouteParams({ id: TX_UUID }),
    )
    const { status, body } = await parseJsonResponse<{ candidate: unknown; candidate_set: typeof set }>(response)
    expect(status).toBe(200)
    expect(body.candidate).toBeNull()
    expect(body.candidate_set).toEqual(set)
    // The row the route already holds is handed over: no second transactions fetch.
    expect(mockDetectSet).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      expect.objectContaining({ id: TX_UUID, amount: 88250, cash_account_id: 'ca-1', journal_entry_id: null }),
    )
  })

  it('fails open per detector: a throwing set detector still returns the 1:1 candidate', async () => {
    enqueue({ data: { id: TX_UUID, date: '2026-07-31', amount: 100, currency: 'SEK', journal_entry_id: null }, error: null })
    const candidate = { journal_entry_id: 'je-1', voucher_label: 'A1', entry_date: '2026-07-31', description: null, amount: 100, bank_account_number: '1930', reason: 'exact_amount_same_date', amount_verified: true, unverified_reason: null }
    mockDetectOne.mockResolvedValue(candidate)
    mockDetectSet.mockRejectedValue(new Error('boom'))

    const response = await GET(
      createMockRequest(`/api/transactions/${TX_UUID}/duplicate-payment-check`),
      createMockRouteParams({ id: TX_UUID }),
    )
    const { status, body } = await parseJsonResponse<{ candidate: unknown; candidate_set: unknown }>(response)
    expect(status).toBe(200)
    expect(body.candidate).toEqual(candidate)
    expect(body.candidate_set).toBeNull()
  })
})
