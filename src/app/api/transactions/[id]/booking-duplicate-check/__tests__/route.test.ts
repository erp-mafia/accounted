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

const { mockDetect } = vi.hoisted(() => ({ mockDetect: vi.fn() }))
vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: mockDetect,
}))

import { GET } from '../route'

const TX_UUID = '11111111-1111-4111-8111-111111111111'
const URL = `/api/transactions/${TX_UUID}/booking-duplicate-check`

// The salary-run shape: the run's verifikat credits 1930 with the net pay on
// the payment date, the bank drew it two days earlier (a Sunday payment date).
const SALARY_TWIN = {
  transaction_id: null,
  journal_entry_id: 'je-salary',
  voucher_label: 'A303',
  entry_date: '2026-10-25',
  description: 'Lön 2026-10',
  amount: 42387,
  account_number: '1930',
  currency: null,
  amount_in_currency: null,
  amount_verified: true,
  unverified_reason: null,
}

describe('GET /api/transactions/[id]/booking-duplicate-check', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 't@t.se' } } })
    mockDetect.mockResolvedValue(null)
  })

  it('returns 401 when unauthenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await GET(createMockRequest(URL), createMockRouteParams({ id: TX_UUID }))
    expect(response.status).toBe(401)
  })

  it('returns 404 when the transaction is not in the company', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    const response = await GET(createMockRequest(URL), createMockRouteParams({ id: TX_UUID }))
    expect(response.status).toBe(404)
    expect(mockDetect).not.toHaveBeenCalled()
  })

  it('returns null for a row that is already linked, without detecting', async () => {
    enqueue({ data: { id: TX_UUID, date: '2026-10-23', amount: -42387, currency: 'SEK', journal_entry_id: 'je-live' }, error: null })
    const response = await GET(createMockRequest(URL), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ candidate: unknown }>(response)
    expect(status).toBe(200)
    expect(body).toEqual({ candidate: null })
    expect(mockDetect).not.toHaveBeenCalled()
  })

  it('returns the twin the booking guard would refuse on', async () => {
    enqueue({
      data: { id: TX_UUID, date: '2026-10-23', amount: -42387, currency: 'SEK', amount_sek: null, exchange_rate: null, journal_entry_id: null, cash_account_id: 'ca-1' },
      error: null,
    })
    mockDetect.mockResolvedValue(SALARY_TWIN)

    const response = await GET(createMockRequest(URL), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ candidate: unknown }>(response)
    expect(status).toBe(200)
    expect(body.candidate).toEqual(SALARY_TWIN)
    // The guard's own target shape, FX trio and bank account included.
    expect(mockDetect).toHaveBeenCalledWith(mockSupabase, 'company-1', {
      id: TX_UUID,
      date: '2026-10-23',
      amount: -42387,
      currency: 'SEK',
      amount_sek: null,
      exchange_rate: null,
      cash_account_id: 'ca-1',
    })
  })

  it('fails open: a throwing detector answers null', async () => {
    enqueue({ data: { id: TX_UUID, date: '2026-10-23', amount: -100, currency: 'SEK', journal_entry_id: null }, error: null })
    mockDetect.mockRejectedValue(new Error('boom'))
    const response = await GET(createMockRequest(URL), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ candidate: unknown }>(response)
    expect(status).toBe(200)
    expect(body).toEqual({ candidate: null })
  })
})
