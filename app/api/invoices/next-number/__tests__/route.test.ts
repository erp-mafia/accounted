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

  it('previews the F-series through the peek RPC for invoices', async () => {
    enqueue({ data: 'F-012', error: null })

    const { status, body } = await parseJsonResponse<{ data: { preview: string | null } }>(await get(''))

    expect(status).toBe(200)
    expect(body.data.preview).toBe('F-012')
    expect(mockSupabase.rpc).toHaveBeenCalledWith('peek_next_invoice_number', {
      p_company_id: 'company-1',
      p_document_type: 'invoice',
    })
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
