import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

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

const mockList = vi.fn()
const mockLink = vi.fn()
vi.mock('@/lib/invoices/invoice-attachments', () => ({
  listInvoiceAttachments: (...args: unknown[]) => mockList(...args),
  linkInvoiceAttachments: (...args: unknown[]) => mockLink(...args),
}))

import { GET, POST } from '../route'

const INVOICE_ID = '550e8400-e29b-41d4-a716-446655440000'
const DOCUMENT_ID = '660e8400-e29b-41d4-a716-446655440000'
const ATTACHMENT = {
  document_id: DOCUMENT_ID,
  file_name: 'tidrapport.pdf',
  mime_type: 'application/pdf',
  file_size_bytes: 1234,
  created_at: '2026-10-16T10:00:00.000Z',
}

describe('/api/invoices/[id]/attachments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'user@example.com' } },
    })
  })

  describe('GET', () => {
    it('returns 401 when not authenticated', async () => {
      mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

      const response = await GET(
        createMockRequest(`/api/invoices/${INVOICE_ID}/attachments`),
        createMockRouteParams({ id: INVOICE_ID }),
      )

      expect(response.status).toBe(401)
    })

    it('returns 400 for a malformed invoice id', async () => {
      const response = await GET(
        createMockRequest('/api/invoices/nope/attachments'),
        createMockRouteParams({ id: 'nope' }),
      )

      expect(response.status).toBe(400)
    })

    it('returns 404 for an invoice outside the active company', async () => {
      enqueue({ data: null })

      const response = await GET(
        createMockRequest(`/api/invoices/${INVOICE_ID}/attachments`),
        createMockRouteParams({ id: INVOICE_ID }),
      )

      expect(response.status).toBe(404)
      expect(mockList).not.toHaveBeenCalled()
    })

    it('lists the invoice attachments', async () => {
      enqueue({ data: { id: INVOICE_ID } })
      mockList.mockResolvedValue([ATTACHMENT])

      const response = await GET(
        createMockRequest(`/api/invoices/${INVOICE_ID}/attachments`),
        createMockRouteParams({ id: INVOICE_ID }),
      )
      const { status, body } = await parseJsonResponse<{ data: unknown[] }>(response)

      expect(status).toBe(200)
      expect(body.data).toEqual([ATTACHMENT])
      expect(mockList).toHaveBeenCalledWith(mockSupabase, 'company-1', INVOICE_ID)
    })
  })

  describe('POST', () => {
    it('returns 401 when not authenticated', async () => {
      mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

      const response = await POST(
        createMockRequest(`/api/invoices/${INVOICE_ID}/attachments`, {
          method: 'POST',
          body: { document_ids: [DOCUMENT_ID] },
        }),
        createMockRouteParams({ id: INVOICE_ID }),
      )

      expect(response.status).toBe(401)
      expect(mockLink).not.toHaveBeenCalled()
    })

    it('returns 400 when document_ids is missing or malformed', async () => {
      for (const body of [{}, { document_ids: [] }, { document_ids: ['not-a-uuid'] }]) {
        const response = await POST(
          createMockRequest(`/api/invoices/${INVOICE_ID}/attachments`, { method: 'POST', body }),
          createMockRouteParams({ id: INVOICE_ID }),
        )
        expect(response.status, JSON.stringify(body)).toBe(400)
      }
      expect(mockLink).not.toHaveBeenCalled()
    })

    it('returns 404 for a document of another company', async () => {
      mockLink.mockResolvedValue({ ok: false, code: 'INVOICE_ATTACHMENT_DOCUMENT_NOT_FOUND' })

      const response = await POST(
        createMockRequest(`/api/invoices/${INVOICE_ID}/attachments`, {
          method: 'POST',
          body: { document_ids: [DOCUMENT_ID] },
        }),
        createMockRouteParams({ id: INVOICE_ID }),
      )
      const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(response)

      expect(status).toBe(404)
      expect(body.error.code).toBe('INVOICE_ATTACHMENT_DOCUMENT_NOT_FOUND')
      expect(body.error.message).toBe('Underlaget hittades inte i företagets arkiv.')
    })

    it('returns 409 once the invoice is sent', async () => {
      mockLink.mockResolvedValue({ ok: false, code: 'INVOICE_ATTACHMENTS_FIXED' })

      const response = await POST(
        createMockRequest(`/api/invoices/${INVOICE_ID}/attachments`, {
          method: 'POST',
          body: { document_ids: [DOCUMENT_ID] },
        }),
        createMockRouteParams({ id: INVOICE_ID }),
      )

      expect(response.status).toBe(409)
    })

    it('returns 400 when the files would exceed the size limit', async () => {
      mockLink.mockResolvedValue({ ok: false, code: 'INVOICE_ATTACHMENTS_TOO_LARGE' })

      const response = await POST(
        createMockRequest(`/api/invoices/${INVOICE_ID}/attachments`, {
          method: 'POST',
          body: { document_ids: [DOCUMENT_ID] },
        }),
        createMockRouteParams({ id: INVOICE_ID }),
      )
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

      expect(status).toBe(400)
      expect(body.error.code).toBe('INVOICE_ATTACHMENTS_TOO_LARGE')
    })

    it('attaches the documents and answers the whole set', async () => {
      mockLink.mockResolvedValue({ ok: true, value: [ATTACHMENT] })

      const response = await POST(
        createMockRequest(`/api/invoices/${INVOICE_ID}/attachments`, {
          method: 'POST',
          body: { document_ids: [DOCUMENT_ID] },
        }),
        createMockRouteParams({ id: INVOICE_ID }),
      )
      const { status, body } = await parseJsonResponse<{ data: unknown[] }>(response)

      expect(status).toBe(200)
      expect(body.data).toEqual([ATTACHMENT])
      expect(mockLink).toHaveBeenCalledWith(mockSupabase, 'company-1', INVOICE_ID, [DOCUMENT_ID])
    })
  })
})
