import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

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

const mockUnlink = vi.fn()
vi.mock('@/lib/invoices/invoice-attachments', () => ({
  unlinkInvoiceAttachment: (...args: unknown[]) => mockUnlink(...args),
}))

import { DELETE } from '../route'

const INVOICE_ID = '550e8400-e29b-41d4-a716-446655440000'
const DOCUMENT_ID = '660e8400-e29b-41d4-a716-446655440000'

function request() {
  return createMockRequest(`/api/invoices/${INVOICE_ID}/attachments/${DOCUMENT_ID}`, { method: 'DELETE' })
}

describe('DELETE /api/invoices/[id]/attachments/[documentId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'user@example.com' } },
    })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const response = await DELETE(request(), createMockRouteParams({ id: INVOICE_ID, documentId: DOCUMENT_ID }))

    expect(response.status).toBe(401)
    expect(mockUnlink).not.toHaveBeenCalled()
  })

  it('returns 400 for malformed ids', async () => {
    const response = await DELETE(request(), createMockRouteParams({ id: INVOICE_ID, documentId: 'nope' }))

    expect(response.status).toBe(400)
    expect(mockUnlink).not.toHaveBeenCalled()
  })

  it('returns 404 for a file that is not attached', async () => {
    mockUnlink.mockResolvedValue({ ok: false, code: 'INVOICE_ATTACHMENT_NOT_FOUND' })

    const response = await DELETE(request(), createMockRouteParams({ id: INVOICE_ID, documentId: DOCUMENT_ID }))

    expect(response.status).toBe(404)
  })

  it('returns 409 with the Swedish retention sentence once the invoice is sent', async () => {
    mockUnlink.mockResolvedValue({ ok: false, code: 'INVOICE_ATTACHMENTS_FIXED' })

    const response = await DELETE(request(), createMockRouteParams({ id: INVOICE_ID, documentId: DOCUMENT_ID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('INVOICE_ATTACHMENTS_FIXED')
    expect(body.error.message).toContain('bokföringslagen')
  })

  it('takes the file off a draft', async () => {
    mockUnlink.mockResolvedValue({ ok: true, value: null })

    const response = await DELETE(request(), createMockRouteParams({ id: INVOICE_ID, documentId: DOCUMENT_ID }))
    const { status, body } = await parseJsonResponse<{ data: { removed: boolean } }>(response)

    expect(status).toBe(200)
    expect(body.data.removed).toBe(true)
    expect(mockUnlink).toHaveBeenCalledWith(mockSupabase, 'company-1', INVOICE_ID, DOCUMENT_ID)
  })
})
