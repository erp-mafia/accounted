import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockRequest, createMockRouteParams, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

const mockReport = vi.fn()
vi.mock('@/lib/invoices/late-payment-interest-report', () => ({
  getLatePaymentInterestReport: (...args: unknown[]) => mockReport(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }
const REPORT = { as_of: '2026-10-26', rate: 0.1, rate_is_override: false, paid_late: [], overdue_open: [], totals: [] }

function get(query = '') {
  return GET(createMockRequest(`/api/invoices/late-payment-interest${query}`), createMockRouteParams({}))
}

describe('GET /api/invoices/late-payment-interest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockReport.mockResolvedValue(REPORT)
  })

  it('returns 401 without a session', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await get()
    expect(response.status).toBe(401)
    expect(mockReport).not.toHaveBeenCalled()
  })

  it('returns 400 on an as_of that is not a date', async () => {
    const response = await get('?as_of=26/10/2026')
    expect(response.status).toBe(400)
    expect(mockReport).not.toHaveBeenCalled()
  })

  it('answers the report for the active company, up to the given date', async () => {
    const { status, body } = await parseJsonResponse<{ data: typeof REPORT }>(await get('?as_of=2026-09-30'))
    expect(status).toBe(200)
    expect(body.data).toEqual(REPORT)
    expect(mockReport).toHaveBeenCalledWith(mockSupabase, 'company-1', '2026-09-30')
  })

  it('computes up to today in Stockholm when no date is given', async () => {
    await get()
    expect(mockReport.mock.calls[0][2]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
