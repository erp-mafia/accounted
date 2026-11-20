import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

function get(query: string) {
  return GET(createMockRequest(`/api/invoices/next-number${query}`, { method: 'GET' }), { params: Promise.resolve({}) })
}

describe('GET /api/invoices/next-number', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const { status } = await parseJsonResponse(await get('?document_type=quote'))

    expect(status).toBe(401)
  })

  it('returns 400 on an unknown document type', async () => {
    const { status } = await parseJsonResponse(await get('?document_type=receipt'))

    expect(status).toBe(400)
  })

  it('previews the number the series would issue for invoices', async () => {
    enqueue({
      data: { prefix: 'F-', next_invoice_number: 12, next_number: 'F-012', highest_number: 11, behind: false, first_allowed: 12 },
      error: null,
    })

    const { status, body } = await parseJsonResponse<{ data: { preview: string | null; behind: boolean } }>(
      await get(''),
    )

    expect(status).toBe(200)
    expect(body.data).toEqual({ preview: 'F-012', behind: false })
    expect(mockSupabase.rpc).toHaveBeenCalledWith('invoice_number_series_status', {
      p_company_id: 'company-1',
      p_document_type: 'invoice',
      p_prefix: null,
      p_next_number: null,
    })
  })

  it('says when the series is behind and which number continues it', async () => {
    enqueue({
      data: { prefix: '', next_invoice_number: 1, next_number: null, highest_number: 114647, behind: true, first_allowed: 114648 },
      error: null,
    })

    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await get(''))

    expect(status).toBe(200)
    expect(body.data).toEqual({
      preview: null,
      behind: true,
      highest_number: '114647',
      first_allowed: 114648,
      continue_number: '114648',
    })
  })

  it('reads the PF- series for proformas', async () => {
    enqueue({
      data: { prefix: 'PF-', next_invoice_number: 3, next_number: 'PF-003', highest_number: 2, behind: false, first_allowed: 3 },
      error: null,
    })

    const { body } = await parseJsonResponse<{ data: { preview: string | null } }>(await get('?document_type=proforma'))

    expect(body.data.preview).toBe('PF-003')
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'invoice_number_series_status',
      expect.objectContaining({ p_document_type: 'proforma' }),
    )
  })

  it('answers a failed series read with the structured error', async () => {
    enqueue({ data: null, error: { code: '42501', message: 'unauthorized: caller is not a member of company' } })

    const { status } = await parseJsonResponse(await get(''))

    expect(status).toBe(403)
  })

  it('previews the OF-series from company_settings for quotes without touching the F-series', async () => {
    enqueue({ data: { next_quote_number: 7 }, error: null })

    const { status, body } = await parseJsonResponse<{ data: { preview: string | null } }>(
      await get('?document_type=quote'),
    )

    expect(status).toBe(200)
    expect(body.data.preview).toBe('OF-007')
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
  })

  it('returns a null preview for quotes when the company has no settings row yet', async () => {
    enqueue({ data: null, error: null })

    const { status, body } = await parseJsonResponse<{ data: { preview: string | null } }>(
      await get('?document_type=quote'),
    )

    expect(status).toBe(200)
    expect(body.data.preview).toBeNull()
  })
})
