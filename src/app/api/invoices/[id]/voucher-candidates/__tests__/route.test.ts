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

const mockFind = vi.fn()
vi.mock('@/lib/invoices/voucher-matching', () => ({
  findMatchingVouchersForInvoice: (...args: unknown[]) => mockFind(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'
const mockUser = { id: 'user-1', email: 'test@test.se' }

function get(query = '') {
  return GET(
    createMockRequest(`/api/invoices/${VALID_UUID}/voucher-candidates${query}`),
    createMockRouteParams({ id: VALID_UUID }),
  )
}

describe('GET /api/invoices/[id]/voucher-candidates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 without a session', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await get()
    expect(response.status).toBe(401)
    expect(mockFind).not.toHaveBeenCalled()
  })

  it('returns 404 when the invoice is not in the company', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await get())
    expect(status).toBe(404)
    expect(body.error.code).toBe('LINK_VOUCHER_INVOICE_NOT_FOUND')
    expect(mockFind).not.toHaveBeenCalled()
  })

  it('returns 400 on a search text longer than any voucher number', async () => {
    const response = await get(`?voucher=${'A'.repeat(41)}`)
    expect(response.status).toBe(400)
    expect(mockFind).not.toHaveBeenCalled()
  })

  it('asks the matcher for vouchers that settle several invoices too: a person picks here (crm#1434)', async () => {
    enqueue({ data: { id: VALID_UUID, status: 'sent', currency: 'SEK' } })
    mockFind.mockResolvedValue([{ journal_entry_id: 'je-1', ar_credit_amount: 8000, link_amount: 2000 }])

    const { status, body } = await parseJsonResponse<{
      data: { candidates: { journal_entry_id: string; link_amount?: number }[] }
    }>(await get())

    expect(status).toBe(200)
    expect(body.data.candidates).toEqual([{ journal_entry_id: 'je-1', ar_credit_amount: 8000, link_amount: 2000 }])
    expect(mockFind).toHaveBeenCalledTimes(1)
    expect(mockFind.mock.calls[0][3]).toEqual({ includeShared: true })
  })

  it('looks up a verifikat named by its number, at any date', async () => {
    enqueue({ data: { id: VALID_UUID, status: 'sent', currency: 'SEK' } })
    mockFind.mockResolvedValue([])

    const { status } = await parseJsonResponse(await get('?voucher=A17'))

    expect(status).toBe(200)
    expect(mockFind.mock.calls[0][3]).toEqual({ includeShared: true, voucher: { series: 'A', number: 17 } })
  })

  it('answers a search text that names no voucher number with no candidates, without searching', async () => {
    enqueue({ data: { id: VALID_UUID, status: 'sent', currency: 'SEK' } })
    const { status, body } = await parseJsonResponse<{ data: { candidates: unknown[] } }>(
      await get('?voucher=kundf%C3%B6rlust'),
    )
    expect(status).toBe(200)
    expect(body.data.candidates).toEqual([])
    expect(mockFind).not.toHaveBeenCalled()
  })

  it('answers a settled invoice with no candidates and never runs the matcher', async () => {
    enqueue({ data: { id: VALID_UUID, status: 'paid', currency: 'SEK' } })
    const { status, body } = await parseJsonResponse<{
      data: { candidates: unknown[]; invoice_status: string }
    }>(await get())
    expect(status).toBe(200)
    expect(body.data.candidates).toEqual([])
    expect(body.data.invoice_status).toBe('paid')
    expect(mockFind).not.toHaveBeenCalled()
  })
})
