import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase, makeTransaction } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

const mockGetBestInvoiceMatch = vi.fn()
vi.mock('@/lib/invoices/invoice-matching', () => ({
  getBestInvoiceMatch: (...args: unknown[]) => mockGetBestInvoiceMatch(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { POST } from '../route'

describe('POST /api/transactions/batch-match-invoices', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const response = await POST()
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('calls the invoice matcher with companyId (not user.id) and records the match', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 12500 })
    enqueue({ data: [tx], error: null }) // fetch uncategorized income transactions
    enqueue({ data: null, error: null }) // update transaction with potential_invoice_id

    mockGetBestInvoiceMatch.mockResolvedValue({ invoice: { id: 'inv-1' }, confidence: 0.9 })

    const response = await POST()
    const { status, body } = await parseJsonResponse<{ processed: number; matched: number }>(response)

    expect(status).toBe(200)
    expect(body).toEqual({ processed: 1, matched: 1 })

    // Regression guard: the matcher's 2nd arg is companyId. The bug passed user.id
    // here, which never equals any invoices.company_id, so it silently matched zero.
    expect(mockGetBestInvoiceMatch).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      expect.objectContaining({ id: 'tx-1' }),
      0.5
    )
    expect(mockGetBestInvoiceMatch).not.toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      expect.anything(),
      expect.anything()
    )
  })

  it('returns matched: 0 when no invoice meets the confidence threshold', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: 12500 })
    enqueue({ data: [tx], error: null })

    mockGetBestInvoiceMatch.mockResolvedValue(null)

    const response = await POST()
    const { status, body } = await parseJsonResponse<{ processed: number; matched: number }>(response)

    expect(status).toBe(200)
    expect(body).toEqual({ processed: 1, matched: 0 })
  })

  it('returns 500 when the transaction fetch fails', async () => {
    enqueue({ data: null, error: { message: 'boom' } })

    const response = await POST()
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect(body.error).toBe('Failed to fetch transactions')
  })
})
