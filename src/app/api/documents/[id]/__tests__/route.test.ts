import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import {
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeDocumentAttachment,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

// The GET route signs with the service-role client: the storage SELECT
// policy only covers the uploader's own folder, so a company member viewing
// a colleague's upload cannot sign with their own client.
const createSignedUrlMock = vi.fn()
const serviceStorageFromMock = vi.fn(() => ({ createSignedUrl: createSignedUrlMock }))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    storage: { from: serviceStorageFromMock },
  }),
}))

// deleteDocument removes storage objects via the cookieless service-role
// client: the documents bucket is WORM (no DELETE policy on storage.objects),
// so a caller-bound remove() is silently blocked by RLS.
const serviceRemoveMock = vi.fn()
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => ({
    storage: { from: vi.fn(() => ({ remove: serviceRemoveMock })) },
  }),
}))

import { GET, DELETE } from '../route'
import { requireWritePermission } from '@/lib/auth/require-write'
import { NextResponse } from 'next/server'

const mockUser = { id: 'user-1', email: 'test@test.se' }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  eventBus.clear()
  requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
  // Reset write-permission mock to default ok
  vi.mocked(requireWritePermission).mockResolvedValue({ ok: true })
  createSignedUrlMock.mockResolvedValue({
    data: { signedUrl: 'https://example.com/signed' },
    error: null,
  })
  serviceRemoveMock.mockResolvedValue({ data: [], error: null })
})

function makeReq(method: 'GET' | 'DELETE' = 'DELETE') {
  return new Request('http://localhost/api/documents/doc-1', { method })
}

/**
 * The five pin reads deleteDocument() makes after the document row, in
 * readDocumentDeletePins' order: supplier invoices, expense claims, bank
 * transactions, inbox items by file, inbox items by received Peppol XML.
 */
function enqueuePins(pins: { supplierInvoice?: boolean; expenseClaim?: boolean; bankTransaction?: boolean; inboxFile?: unknown[]; inboxXml?: unknown[] } = {}) {
  enqueue({ data: pins.supplierInvoice ? [{ id: 'si-1' }] : [] })
  enqueue({ data: pins.expenseClaim ? [{ id: 'ec-1' }] : [] })
  enqueue({ data: pins.bankTransaction ? [{ id: 'tx-1' }] : [] })
  enqueue({ data: pins.inboxFile ?? [] })
  enqueue({ data: pins.inboxXml ?? [] })
}

const LOOSE_DOC = {
  id: 'doc-1',
  file_name: 'kvitto.pdf',
  storage_path: 'documents/user-1/kvitto.pdf',
  journal_entry_id: null,
  journal_entry_line_id: null,
  user_id: 'user-1',
}

describe('GET /api/documents/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(makeReq('GET'), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse(res)
    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 when the document is not found in the company', async () => {
    enqueue({ data: null, error: null }) // doc lookup
    const res = await GET(makeReq('GET'), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(404)
    expect(body.error).toBe('Document not found')
  })

  it('returns 500 when the signed URL cannot be created', async () => {
    enqueue({ data: makeDocumentAttachment({ id: 'doc-1' }), error: null })
    createSignedUrlMock.mockResolvedValue({ data: null, error: { message: 'boom' } })

    const res = await GET(makeReq('GET'), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)

    expect(status).toBe(500)
    expect(body.error).toContain('Failed to create download URL')
  })

  it('returns the document with a signed download URL and emits document.accessed', async () => {
    const row = makeDocumentAttachment({
      id: 'doc-1',
      file_name: 'kvitto.pdf',
      storage_path: 'documents/user-1/kvitto.pdf',
    })
    enqueue({ data: row, error: null })

    const handler = vi.fn()
    eventBus.on('document.accessed', handler)

    const res = await GET(makeReq('GET'), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{
      data: { id: string; download_url: string }
    }>(res)

    expect(status).toBe(200)
    expect(body.data.id).toBe('doc-1')
    expect(body.data.download_url).toBe('https://example.com/signed')

    expect(serviceStorageFromMock).toHaveBeenCalledWith('documents')
    expect(createSignedUrlMock).toHaveBeenCalledWith('documents/user-1/kvitto.pdf', 3600)

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        document: expect.objectContaining({ id: 'doc-1', file_name: 'kvitto.pdf' }),
        userId: 'user-1',
        companyId: 'company-1',
      }),
    )
  })

  it('signs attachments stored under another company member folder', async () => {
    // Regression: the storage SELECT policy is per-uploader-folder, so signing
    // with the user-bound client failed for every colleague-uploaded document
    // ("Failed to create download URL"). The service client must sign after
    // the company-scoped row fetch has authorized access.
    const row = makeDocumentAttachment({
      id: 'doc-2',
      file_name: 'leverantorsfaktura.pdf',
      storage_path: 'documents/other-member/leverantorsfaktura.pdf',
    })
    enqueue({ data: row, error: null })

    const res = await GET(makeReq('GET'), createMockRouteParams({ id: 'doc-2' }))
    const { status, body } = await parseJsonResponse<{
      data: { download_url: string }
    }>(res)

    expect(status).toBe(200)
    expect(body.data.download_url).toBe('https://example.com/signed')
    expect(createSignedUrlMock).toHaveBeenCalledWith(
      'documents/other-member/leverantorsfaktura.pdf',
      3600,
    )
    // The user-bound client must not be used for signing at all.
    expect(mockSupabase.storage.from).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/documents/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await DELETE(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse(res)
    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 403 when caller has read-only role', async () => {
    vi.mocked(requireWritePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { error: 'Du har endast läsbehörighet i detta företag.' },
        { status: 403 },
      ),
    })
    const res = await DELETE(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(403)
  })

  it('returns 404 when document not found in company', async () => {
    enqueue({ data: null, error: null }) // doc lookup
    const res = await DELETE(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(res)
    expect(status).toBe(404)
    // Failures ride the structured envelope now (sessionFailureResponse).
    expect(body.error.code).toBe('DOC_NOT_FOUND')
  })

  it('returns 409 with BFL message when doc is linked to a journal entry', async () => {
    enqueue({
      data: {
        id: 'doc-1',
        file_name: 'kvitto.pdf',
        storage_path: 'documents/user-1/kvitto.pdf',
        journal_entry_id: 'je-99',
        user_id: 'user-1',
      },
      error: null,
    })
    const res = await DELETE(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(res)
    expect(status).toBe(409)
    expect(body.error.message).toContain('Bokföringslagen')
    expect(body.error.message).toContain('7 kap')
  })

  it('deletes the row, removes Storage file, and emits document.deleted on unlinked doc', async () => {
    enqueue({
      data: {
        id: 'doc-1',
        file_name: 'kvitto.pdf',
        storage_path: 'documents/user-1/kvitto.pdf',
        journal_entry_id: null,
        user_id: 'user-1',
      },
      error: null,
    })
    enqueuePins()
    enqueue({ data: null, error: null }) // delete

    const handler = vi.fn()
    eventBus.on('document.deleted', handler)

    const res = await DELETE(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{ data: { id: string; deleted: boolean } }>(res)

    expect(status).toBe(200)
    expect(body.data).toEqual({ id: 'doc-1', deleted: true })

    // Both storage layouts are removed: the stored pointer plus the alternate
    // candidate key. During the company-scoped path migration a document can
    // exist under either prefix, and removing only the stored one would leave a
    // readable orphan copy of a document the user asked to erase. The removal
    // must go through the service-role client (WORM bucket: RLS silently
    // blocks a caller-bound remove()), never the user-bound client.
    expect(serviceRemoveMock).toHaveBeenCalledWith([
      'documents/user-1/kvitto.pdf',
      'documents/company-1/user-1/kvitto.pdf',
      // The viewer's preview goes with the file it was made from.
      'previews/company-1/doc-1-v1.jpg',
    ])
    expect(mockSupabase.storage.from).not.toHaveBeenCalled()

    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        document: expect.objectContaining({ id: 'doc-1', file_name: 'kvitto.pdf' }),
        userId: 'user-1',
        companyId: 'company-1',
      }),
    )
  })

  it('returns 409 with BFL message when DB trigger blocks deletion (defense-in-depth)', async () => {
    // Caller bypasses the application-layer check (e.g. race condition).
    // The block_document_deletion() trigger raises with "Bokföringslagen" in the
    // message; the service maps it to a 409.
    enqueue({
      data: {
        id: 'doc-1',
        file_name: 'kvitto.pdf',
        storage_path: 'documents/user-1/kvitto.pdf',
        journal_entry_id: null,
        user_id: 'user-1',
      },
      error: null,
    })
    enqueuePins()
    enqueue({
      data: null,
      error: { message: 'Cannot delete document linked to a posted journal entry (Bokföringslagen)' },
    })

    const res = await DELETE(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(res)
    expect(status).toBe(409)
    expect(body.error.message).toContain('Bokföringslagen')
  })

  it('returns 409 DOC_DELETE_LINKED for a document linked only at a verifikat line, without deleting', async () => {
    enqueue({
      data: {
        id: 'doc-1',
        file_name: 'kvitto.pdf',
        storage_path: 'documents/user-1/kvitto.pdf',
        journal_entry_id: null,
        journal_entry_line_id: 'line-1',
        user_id: 'user-1',
      },
      error: null,
    })
    const res = await DELETE(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(res)
    expect(status).toBe(409)
    expect(body.error.code).toBe('DOC_DELETE_LINKED')
    expect(body.error.message).toContain('7 kap')
    expect(serviceRemoveMock).not.toHaveBeenCalled()
  })

  it('returns 409 DOCUMENT_DELETE_BLOCKED_BY_TRANSACTION when a bank transaction pins the document between the pin read and the delete (FK RESTRICT), not a 500', async () => {
    // A receipt attached to a bank transaction after the pins were read:
    // transactions.document_id is ON DELETE RESTRICT, so the database refuses
    // the delete with 23503 and the shared foreign-key refusal map answers it.
    enqueue({
      data: {
        id: 'doc-1',
        file_name: 'kvitto.pdf',
        storage_path: 'documents/user-1/kvitto.pdf',
        journal_entry_id: null,
        journal_entry_line_id: null,
        user_id: 'user-1',
      },
      error: null,
    })
    enqueuePins()
    enqueue({
      data: null,
      error: {
        code: '23503',
        message: 'update or delete on table "document_attachments" violates foreign key constraint "transactions_document_id_fkey" on table "transactions"',
      },
    })
    const res = await DELETE(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; message_en: string; details: { referenced_by: string } }
    }>(res)
    expect(status).toBe(409)
    expect(body.error.code).toBe('DOCUMENT_DELETE_BLOCKED_BY_TRANSACTION')
    expect(body.error.message).toContain('banktransaktion')
    expect(body.error.message_en).toContain('bank transaction')
    expect(body.error.details.referenced_by).toBe('transactions')
    expect(serviceRemoveMock).not.toHaveBeenCalled()
  })
  // crm#230: every record that holds a document is refused by the server rule
  // itself (documentDeleteRefusal), so the API and agents get the same answer
  // Arkiv's missing button implies.
  it.each([
    {
      pin: 'the underlag of a registered supplier invoice',
      pins: { supplierInvoice: true },
      code: 'DOC_DELETE_SUPPLIER_INVOICE_UNDERLAG',
      sv: 'registrerad leverantörsfaktura',
      en: 'supplier invoice',
    },
    { pin: 'the underlag of an utlägg', pins: { expenseClaim: true }, code: 'DOC_DELETE_EXPENSE_CLAIM_UNDERLAG', sv: 'registrerat utlägg', en: 'expense claim' },
    {
      pin: 'the file of an inbox item booked through a verifikat',
      pins: { inboxFile: [{ created_journal_entry_id: 'je-1', created_supplier_invoice_id: null }] },
      code: 'DOC_DELETE_BOOKED_INBOX_ITEM',
      sv: 'redan har bokförts',
      en: 'already been booked',
    },
    {
      pin: 'the received Peppol XML of an e-invoice turned into a supplier invoice',
      pins: { inboxXml: [{ created_journal_entry_id: null, created_supplier_invoice_id: 'si-1' }] },
      code: 'DOC_DELETE_BOOKED_INBOX_ITEM',
      sv: 'i det skick det togs emot',
      en: 'form it was received',
    },
    { pin: 'the underlag of a bank transaction', pins: { bankTransaction: true }, code: 'DOCUMENT_DELETE_BLOCKED_BY_TRANSACTION', sv: 'banktransaktion', en: 'bank transaction' },
  ])('returns 409 $code for $pin, deleting nothing', async ({ pins, code, sv, en }) => {
    enqueue({ data: LOOSE_DOC, error: null })
    enqueuePins(pins)
    const res = await DELETE(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string; message_en: string } }>(res)
    expect(status).toBe(409)
    expect(body.error.code).toBe(code)
    expect(body.error.message).toContain(sv)
    expect(body.error.message_en).toContain(en)
    expect(serviceRemoveMock).not.toHaveBeenCalled()
    expect(findCalls('document_attachments', 'delete')).toEqual([])
  })

  it('deletes a loose document whose inbox item was never booked', async () => {
    enqueue({ data: LOOSE_DOC, error: null })
    enqueuePins({ inboxFile: [{ created_journal_entry_id: null, created_supplier_invoice_id: null }] })
    enqueue({ data: null, error: null }) // delete
    const res = await DELETE(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{ data: { id: string; deleted: boolean } }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual({ id: 'doc-1', deleted: true })
    expect(findCalls('document_attachments', 'delete')).toHaveLength(1)
    expect(serviceRemoveMock).toHaveBeenCalledOnce()
  })
})
