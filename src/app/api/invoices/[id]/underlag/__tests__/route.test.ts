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

const mockRequireWrite = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => mockRequireWrite(...args),
}))

const mockList = vi.fn()
const mockAttach = vi.fn()
const mockDetach = vi.fn()
vi.mock('@/lib/invoices/invoice-underlag', () => ({
  listInvoiceUnderlag: (...args: unknown[]) => mockList(...args),
  attachInvoiceUnderlag: (...args: unknown[]) => mockAttach(...args),
  detachInvoiceUnderlag: (...args: unknown[]) => mockDetach(...args),
  MAX_UNDERLAG_PER_CALL: 25,
}))

import { GET, POST } from '../route'
import { DELETE } from '../[documentId]/route'

const INVOICE_ID = '550e8400-e29b-41d4-a716-446655440000'
const DOCUMENT_ID = '660e8400-e29b-41d4-a716-446655440000'
const UNDERLAG = {
  document_id: DOCUMENT_ID,
  file_name: 'dahl-88412.pdf',
  mime_type: 'application/pdf',
  file_size_bytes: 1234,
  journal_entry_id: null,
  voucher: null,
  document_created_at: '2026-10-02T08:00:00.000Z',
  attached_at: '2026-11-06T10:00:00.000Z',
}

describe('/api/invoices/[id]/underlag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'user@example.com' } },
    })
    mockRequireWrite.mockResolvedValue({ ok: true })
  })

  describe('GET', () => {
    it('returns 401 when not authenticated', async () => {
      mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

      const response = await GET(createMockRequest(`/api/invoices/${INVOICE_ID}/underlag`), createMockRouteParams({ id: INVOICE_ID }))

      expect(response.status).toBe(401)
      expect(mockList).not.toHaveBeenCalled()
    })

    it('returns 404 for a malformed invoice id without a lookup', async () => {
      const response = await GET(createMockRequest('/api/invoices/nope/underlag'), createMockRouteParams({ id: 'nope' }))

      expect(response.status).toBe(404)
      expect(mockList).not.toHaveBeenCalled()
    })

    it('returns 404 for an invoice outside the active company', async () => {
      mockList.mockResolvedValue({ ok: false, code: 'INVOICE_NOT_FOUND' })

      const response = await GET(createMockRequest(`/api/invoices/${INVOICE_ID}/underlag`), createMockRouteParams({ id: INVOICE_ID }))

      expect(response.status).toBe(404)
      const { body } = await parseJsonResponse<{ error: { code: string } }>(response)
      expect(body.error.code).toBe('INVOICE_NOT_FOUND')
    })

    it('lists the underlag of the active company', async () => {
      mockList.mockResolvedValue({ ok: true, data: { invoice_id: INVOICE_ID, underlag: [UNDERLAG] } })

      const response = await GET(createMockRequest(`/api/invoices/${INVOICE_ID}/underlag`), createMockRouteParams({ id: INVOICE_ID }))

      expect(response.status).toBe(200)
      const { body } = await parseJsonResponse<{ data: unknown }>(response)
      expect(body.data).toEqual({ invoice_id: INVOICE_ID, underlag: [UNDERLAG] })
      expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1' }), INVOICE_ID)
    })
  })

  describe('POST', () => {
    it('returns 401 when not authenticated', async () => {
      mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

      const response = await POST(
        createMockRequest(`/api/invoices/${INVOICE_ID}/underlag`, { method: 'POST', body: { document_ids: [DOCUMENT_ID] } }),
        createMockRouteParams({ id: INVOICE_ID }),
      )

      expect(response.status).toBe(401)
      expect(mockAttach).not.toHaveBeenCalled()
    })

    it('refuses a viewer', async () => {
      mockRequireWrite.mockResolvedValue({ ok: false, response: Response.json({ error: 'read only' }, { status: 403 }) })

      const response = await POST(
        createMockRequest(`/api/invoices/${INVOICE_ID}/underlag`, { method: 'POST', body: { document_ids: [DOCUMENT_ID] } }),
        createMockRouteParams({ id: INVOICE_ID }),
      )

      expect(response.status).toBe(403)
      expect(mockAttach).not.toHaveBeenCalled()
    })

    it('returns 400 for an empty or malformed document list', async () => {
      for (const body of [{ document_ids: [] }, { document_ids: ['nope'] }, {}]) {
        const response = await POST(
          createMockRequest(`/api/invoices/${INVOICE_ID}/underlag`, { method: 'POST', body }),
          createMockRouteParams({ id: INVOICE_ID }),
        )
        expect(response.status).toBe(400)
      }
      expect(mockAttach).not.toHaveBeenCalled()
    })

    it('returns the service refusal for a document outside the archive', async () => {
      mockAttach.mockResolvedValue({ ok: false, code: 'INVOICE_ATTACHMENT_DOCUMENT_NOT_FOUND', details: { document_ids: [DOCUMENT_ID] } })

      const response = await POST(
        createMockRequest(`/api/invoices/${INVOICE_ID}/underlag`, { method: 'POST', body: { document_ids: [DOCUMENT_ID] } }),
        createMockRouteParams({ id: INVOICE_ID }),
      )

      expect(response.status).toBe(404)
    })

    it('links the documents and answers the list', async () => {
      mockAttach.mockResolvedValue({
        ok: true,
        data: { invoice_id: INVOICE_ID, attached_document_ids: [DOCUMENT_ID], underlag: [UNDERLAG] },
      })

      const response = await POST(
        createMockRequest(`/api/invoices/${INVOICE_ID}/underlag`, { method: 'POST', body: { document_ids: [DOCUMENT_ID] } }),
        createMockRouteParams({ id: INVOICE_ID }),
      )

      expect(response.status).toBe(200)
      expect(mockAttach).toHaveBeenCalledWith(
        expect.objectContaining({ companyId: 'company-1' }),
        { invoice_id: INVOICE_ID, document_ids: [DOCUMENT_ID] },
        { dryRun: false },
      )
      const { body } = await parseJsonResponse<{ data: { underlag: unknown[] } }>(response)
      expect(body.data.underlag).toEqual([UNDERLAG])
    })
  })

  describe('DELETE [documentId]', () => {
    it('returns 401 when not authenticated', async () => {
      mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

      const response = await DELETE(
        createMockRequest(`/api/invoices/${INVOICE_ID}/underlag/${DOCUMENT_ID}`, { method: 'DELETE' }),
        createMockRouteParams({ id: INVOICE_ID, documentId: DOCUMENT_ID }),
      )

      expect(response.status).toBe(401)
    })

    it('returns 404 for a document the invoice does not rest on', async () => {
      mockDetach.mockResolvedValue({ ok: false, code: 'INVOICE_UNDERLAG_NOT_FOUND', details: { document_id: DOCUMENT_ID } })

      const response = await DELETE(
        createMockRequest(`/api/invoices/${INVOICE_ID}/underlag/${DOCUMENT_ID}`, { method: 'DELETE' }),
        createMockRouteParams({ id: INVOICE_ID, documentId: DOCUMENT_ID }),
      )

      expect(response.status).toBe(404)
    })

    it('returns 404 for a malformed document id without a lookup', async () => {
      const response = await DELETE(
        createMockRequest(`/api/invoices/${INVOICE_ID}/underlag/nope`, { method: 'DELETE' }),
        createMockRouteParams({ id: INVOICE_ID, documentId: 'nope' }),
      )

      expect(response.status).toBe(404)
      expect(mockDetach).not.toHaveBeenCalled()
    })

    it('removes the link', async () => {
      mockDetach.mockResolvedValue({ ok: true, data: { invoice_id: INVOICE_ID, document_id: DOCUMENT_ID, detached: true } })

      const response = await DELETE(
        createMockRequest(`/api/invoices/${INVOICE_ID}/underlag/${DOCUMENT_ID}`, { method: 'DELETE' }),
        createMockRouteParams({ id: INVOICE_ID, documentId: DOCUMENT_ID }),
      )

      expect(response.status).toBe(200)
      expect(mockDetach).toHaveBeenCalledWith(
        expect.objectContaining({ companyId: 'company-1' }),
        { invoice_id: INVOICE_ID, document_id: DOCUMENT_ID },
        { dryRun: false },
      )
    })
  })
})
