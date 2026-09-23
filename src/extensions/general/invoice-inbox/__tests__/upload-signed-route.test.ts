import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invoiceInboxExtension } from '@/extensions/general/invoice-inbox'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'

// The two Storage primitives are the seam: the routes must hand the RAW
// signed URL out, and hand the reservation back with the inbox's own
// options. Everything after archival is processArchivedDocument, mocked so
// this file asserts the hand-off, not the extraction pipeline (covered by
// upload-page-count-gate / sandbox-skip-extraction).
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: vi.fn(),
  createPendingDocumentUpload: vi.fn(),
  completePendingDocumentUpload: vi.fn(),
  linkToJournalEntry: vi.fn(),
}))

vi.mock('@/extensions/general/invoice-inbox/lib/upload-and-extract', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/extensions/general/invoice-inbox/lib/upload-and-extract')
  >()
  return { ...actual, processArchivedDocument: vi.fn() }
})

vi.mock('@/lib/rate-limits/inbox', () => ({
  checkInboxUploadRateLimit: vi.fn(),
}))

import {
  createPendingDocumentUpload,
  completePendingDocumentUpload,
} from '@/lib/core/documents/document-service'
import { processArchivedDocument } from '@/extensions/general/invoice-inbox/lib/upload-and-extract'
import { checkInboxUploadRateLimit } from '@/lib/rate-limits/inbox'

function findRoute(method: string, path: string) {
  return invoiceInboxExtension.apiRoutes!.find(
    (r) => r.method === method && r.path === path,
  )!
}

const createRoute = findRoute('POST', '/upload/create')
const completeRoute = findRoute('POST', '/upload/complete')

const UPLOAD_ID = '33333333-3333-4333-8333-333333333333'
const TX_ID = '44444444-4444-4444-8444-444444444444'
const RAW_SIGNED_URL =
  'https://proj.supabase.co/storage/v1/object/upload/sign/documents/documents/company-1/user-1/pending/x.pdf?token=signed'

function buildCtx(supabase: unknown): ExtensionContext {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'invoice-inbox',
    requestId: 'req_test',
    supabase: supabase as ExtensionContext['supabase'],
    emit: vi.fn(),
    settings: { get: vi.fn(), set: vi.fn() },
    storage: { from: vi.fn() } as unknown as ExtensionContext['storage'],
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ExtensionContext['log'],
    services: {},
  } as unknown as ExtensionContext
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    file_name: 'faktura.pdf',
    mime_type: 'application/pdf',
    size_bytes: 6 * 1024 * 1024,
    ...overrides,
  }
}

function completeBody(overrides: Record<string, unknown> = {}) {
  return {
    upload_id: UPLOAD_ID,
    file_name: 'faktura.pdf',
    mime_type: 'application/pdf',
    ...overrides,
  }
}

type Envelope = { error: { code: string; message: string; message_en?: string } }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(checkInboxUploadRateLimit).mockResolvedValue({ ok: true })
  vi.mocked(createPendingDocumentUpload).mockResolvedValue({
    uploadId: UPLOAD_ID,
    signedUrl: RAW_SIGNED_URL,
    expiresAt: '2026-08-28T12:00:00.000Z',
  })
})

describe('POST /upload/create (signed direct-to-storage upload)', () => {
  it('returns 401 without a context', async () => {
    const res = await createRoute.handler(createMockRequest('/upload/create', { method: 'POST', body: createBody() }))
    expect(res.status).toBe(401)
  })

  it('returns 400 on an invalid body', async () => {
    const mock = createQueuedMockSupabase()
    const res = await createRoute.handler(
      createMockRequest('/upload/create', { method: 'POST', body: { file_name: 'x.pdf' } }),
      buildCtx(mock.supabase),
    )
    const { status, body } = await parseJsonResponse<{ type: string }>(res)
    expect(status).toBe(400)
    expect(body.type).toBe('validation_error')
    expect(createPendingDocumentUpload).not.toHaveBeenCalled()
  })

  it('refuses a MIME type the inbox does not accept', async () => {
    const mock = createQueuedMockSupabase()
    const res = await createRoute.handler(
      createMockRequest('/upload/create', { method: 'POST', body: createBody({ mime_type: 'text/html' }) }),
      buildCtx(mock.supabase),
    )
    const { status, body } = await parseJsonResponse<Envelope>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('INBOX_UPLOAD_UNSUPPORTED_TYPE')
    expect(createPendingDocumentUpload).not.toHaveBeenCalled()
  })

  it('refuses a file over the inbox ceiling before minting a URL', async () => {
    const mock = createQueuedMockSupabase()
    const res = await createRoute.handler(
      createMockRequest('/upload/create', { method: 'POST', body: createBody({ size_bytes: 10 * 1024 * 1024 + 1 }) }),
      buildCtx(mock.supabase),
    )
    const { status, body } = await parseJsonResponse<Envelope>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('INBOX_UPLOAD_TOO_LARGE')
    expect(body.error.message).toContain('10 MB')
    expect(createPendingDocumentUpload).not.toHaveBeenCalled()
  })

  it('is rate-limited like /upload and mints nothing when limited', async () => {
    vi.mocked(checkInboxUploadRateLimit).mockResolvedValueOnce({
      ok: false,
      scope: 'minute',
      retryAfterSec: 42,
    })
    const mock = createQueuedMockSupabase()
    const res = await createRoute.handler(
      createMockRequest('/upload/create', { method: 'POST', body: createBody() }),
      buildCtx(mock.supabase),
    )
    const { status, body } = await parseJsonResponse<Envelope & { retry_after: number }>(res)
    expect(status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('42')
    expect(body.error.code).toBe('RATE_LIMITED')
    expect(checkInboxUploadRateLimit).toHaveBeenCalledWith(mock.supabase, 'company-1')
    expect(createPendingDocumentUpload).not.toHaveBeenCalled()
  })

  it('reserves a company-scoped upload with the user client and returns the RAW signed URL', async () => {
    const mock = createQueuedMockSupabase()
    const res = await createRoute.handler(
      createMockRequest('/upload/create', { method: 'POST', body: createBody() }),
      buildCtx(mock.supabase),
    )
    const { status, body } = await parseJsonResponse<{
      data: { upload_id: string; upload_url: string; expires_at: string }
    }>(res)

    expect(status).toBe(200)
    expect(createPendingDocumentUpload).toHaveBeenCalledTimes(1)
    const [client, companyId, userId, uploadId, fileName] =
      vi.mocked(createPendingDocumentUpload).mock.calls[0]
    // The user-scoped client: storage RLS decides whether this member may
    // write under the company prefix. A fresh UUID per reservation.
    expect(client).toBe(mock.supabase)
    expect(companyId).toBe('company-1')
    expect(userId).toBe('user-1')
    expect(uploadId).toMatch(/^[0-9a-f-]{36}$/)
    expect(fileName).toBe('faktura.pdf')
    // Never the /api/storage proxy: it buffers the body in a function.
    expect(body.data.upload_url).toBe(RAW_SIGNED_URL)
    expect(body.data.upload_url).not.toContain('/api/storage/')
    expect(body.data.upload_id).toBe(UPLOAD_ID)
    expect(body.data.expires_at).toBe('2026-08-28T12:00:00.000Z')
  })

  it('maps a reservation failure to the Swedish registry copy, never the raw message', async () => {
    vi.mocked(createPendingDocumentUpload).mockRejectedValueOnce(
      new Error('Failed to create document upload URL: bucket exploded'),
    )
    const mock = createQueuedMockSupabase()
    const res = await createRoute.handler(
      createMockRequest('/upload/create', { method: 'POST', body: createBody() }),
      buildCtx(mock.supabase),
    )
    const { status, body } = await parseJsonResponse<Envelope>(res)
    expect(status).toBe(500)
    expect(body.error.code).toBe('INBOX_UPLOAD_FAILED')
    expect(body.error.message).toBe('Uppladdningen misslyckades. Försök igen.')
    expect(body.error.message_en).not.toContain('bucket exploded')
  })
})

describe('POST /upload/complete (signed direct-to-storage upload)', () => {
  const archived = { id: UPLOAD_ID, file_name: 'faktura.pdf', mime_type: 'application/pdf' }
  const pipelineResult = {
    document_id: UPLOAD_ID,
    inbox_item_id: 'inbox-1',
    status: 'processing',
    extracted_data: null,
    matched_supplier_id: null,
    matched_transaction_id: null,
    extraction_skipped: false,
    skip_reason: null,
    page_count: 3,
  }

  it('returns 401 without a context', async () => {
    const res = await completeRoute.handler(
      createMockRequest('/upload/complete', { method: 'POST', body: completeBody() }),
    )
    expect(res.status).toBe(401)
  })

  it('returns 400 when upload_id is not a UUID', async () => {
    const mock = createQueuedMockSupabase()
    const res = await completeRoute.handler(
      createMockRequest('/upload/complete', { method: 'POST', body: completeBody({ upload_id: 'not-a-uuid' }) }),
      buildCtx(mock.supabase),
    )
    const { status, body } = await parseJsonResponse<{ type: string }>(res)
    expect(status).toBe(400)
    expect(body.type).toBe('validation_error')
    expect(completePendingDocumentUpload).not.toHaveBeenCalled()
  })

  it('refuses a MIME type the inbox does not accept', async () => {
    const mock = createQueuedMockSupabase()
    const res = await completeRoute.handler(
      createMockRequest('/upload/complete', { method: 'POST', body: completeBody({ mime_type: 'text/html' }) }),
      buildCtx(mock.supabase),
    )
    const { status, body } = await parseJsonResponse<Envelope>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('INBOX_UPLOAD_UNSUPPORTED_TYPE')
    expect(completePendingDocumentUpload).not.toHaveBeenCalled()
  })

  it('rejects a matched_transaction_id outside the company before touching Storage', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: null }) // transactions lookup: not ours
    const res = await completeRoute.handler(
      createMockRequest('/upload/complete', {
        method: 'POST',
        body: completeBody({ matched_transaction_id: TX_ID }),
      }),
      buildCtx(mock.supabase),
    )
    const { status, body } = await parseJsonResponse<Envelope>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('INBOX_UPLOAD_TX_NOT_IN_COMPANY')
    expect(completePendingDocumentUpload).not.toHaveBeenCalled()
  })

  it('archives through the reservation and joins the multipart pipeline (deferred extraction)', async () => {
    const buffer = new TextEncoder().encode('%PDF-1.4\n').buffer as ArrayBuffer
    vi.mocked(completePendingDocumentUpload).mockResolvedValueOnce({
      document: archived as never,
      buffer,
    })
    vi.mocked(processArchivedDocument).mockResolvedValueOnce(pipelineResult as never)
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: { id: TX_ID } }) // transactions lookup: ours
    mock.enqueue({ data: null }) // no inbox item yet for this document

    const res = await completeRoute.handler(
      createMockRequest('/upload/complete', {
        method: 'POST',
        body: completeBody({ matched_transaction_id: TX_ID, skip_extraction: true }),
      }),
      buildCtx(mock.supabase),
    )
    const { status, body } = await parseJsonResponse<{ data: typeof pipelineResult }>(res)

    expect(status).toBe(200)
    expect(body.data).toEqual(pipelineResult)

    // The complete step never spends rate-limit quota: create already did.
    expect(checkInboxUploadRateLimit).not.toHaveBeenCalled()

    expect(completePendingDocumentUpload).toHaveBeenCalledWith(
      mock.supabase,
      'company-1',
      'user-1',
      UPLOAD_ID,
      'faktura.pdf',
      'application/pdf',
      undefined,
      { extractionOwner: 'invoice-inbox', uploadSource: 'file_upload', dedupeByContent: true },
    )
    expect(processArchivedDocument).toHaveBeenCalledWith(
      mock.supabase,
      'user-1',
      'company-1',
      archived,
      { name: 'faktura.pdf', buffer, type: 'application/pdf' },
      'upload',
      undefined,
      TX_ID,
      { skipExtraction: true, deferExtraction: true },
    )
  })

  it('is idempotent: a second complete returns the inbox item that already exists', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({
      data: {
        id: 'inbox-1',
        status: 'received',
        extracted_data: { totals: { total: 125 } },
        matched_supplier_id: 'sup-1',
        matched_transaction_id: null,
        extraction_skipped: false,
      },
    })

    const res = await completeRoute.handler(
      createMockRequest('/upload/complete', { method: 'POST', body: completeBody() }),
      buildCtx(mock.supabase),
    )
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)

    expect(status).toBe(200)
    expect(body.data).toEqual({
      document_id: UPLOAD_ID,
      inbox_item_id: 'inbox-1',
      status: 'received',
      extracted_data: { totals: { total: 125 } },
      matched_supplier_id: 'sup-1',
      matched_transaction_id: null,
      extraction_skipped: false,
      skip_reason: null,
      page_count: null,
      already_completed: true,
    })
    expect(completePendingDocumentUpload).not.toHaveBeenCalled()
    expect(processArchivedDocument).not.toHaveBeenCalled()
  })

  it('maps a viewer-role RLS denial on the document insert to 403 in Swedish', async () => {
    vi.mocked(completePendingDocumentUpload).mockRejectedValueOnce(
      Object.assign(
        new Error(
          'Failed to create document record: new row violates row-level security policy for table "document_attachments"',
        ),
        { code: '42501' },
      ),
    )
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: null })

    const res = await completeRoute.handler(
      createMockRequest('/upload/complete', { method: 'POST', body: completeBody() }),
      buildCtx(mock.supabase),
    )
    const { status, body } = await parseJsonResponse<Envelope>(res)

    expect(status).toBe(403)
    expect(body.error.code).toBe('INBOX_UPLOAD_NOT_PERMITTED')
    expect(body.error.message).toContain('behörighet')
    expect(body.error.message).not.toContain('row-level')
    expect(processArchivedDocument).not.toHaveBeenCalled()
  })

  it('maps an expired or never-written reservation to 404 in Swedish', async () => {
    vi.mocked(completePendingDocumentUpload).mockRejectedValueOnce(
      Object.assign(
        new Error('Document upload was not found or has expired. Create a new upload URL and try again.'),
        { code: 'DOCUMENT_UPLOAD_NOT_FOUND' },
      ),
    )
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: null })

    const res = await completeRoute.handler(
      createMockRequest('/upload/complete', { method: 'POST', body: completeBody() }),
      buildCtx(mock.supabase),
    )
    const { status, body } = await parseJsonResponse<Envelope>(res)

    expect(status).toBe(404)
    expect(body.error.code).toBe('DOCUMENT_UPLOAD_NOT_FOUND')
    expect(body.error.message).toContain('Ladda upp filen igen')
  })

  it("answers 400 with the document service's authored Swedish sentence on a magic-byte mismatch", async () => {
    const verdict =
      'Filinnehållet matchar inte den angivna filtypen (förväntade application/pdf, hittade image/png).'
    vi.mocked(completePendingDocumentUpload).mockRejectedValueOnce(
      Object.assign(new Error(verdict), { code: 'DOC_UPLOAD_INVALID_CONTENT', messageSv: verdict }),
    )
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: null })

    const res = await completeRoute.handler(
      createMockRequest('/upload/complete', { method: 'POST', body: completeBody() }),
      buildCtx(mock.supabase),
    )
    const { status, body } = await parseJsonResponse<Envelope>(res)

    expect(status).toBe(400)
    expect(body.error.code).toBe('DOC_UPLOAD_INVALID_CONTENT')
    expect(body.error.message).toBe(verdict)
    expect(body.error.message_en).toContain('could not be read')
    expect(processArchivedDocument).not.toHaveBeenCalled()
  })

  it('answers 400 with registry copy when the PUT left an empty object', async () => {
    vi.mocked(completePendingDocumentUpload).mockRejectedValueOnce(
      Object.assign(new Error('Uploaded file is empty'), { code: 'DOC_UPLOAD_EMPTY' }),
    )
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: null })

    const res = await completeRoute.handler(
      createMockRequest('/upload/complete', { method: 'POST', body: completeBody() }),
      buildCtx(mock.supabase),
    )
    const { status, body } = await parseJsonResponse<Envelope>(res)

    expect(status).toBe(400)
    expect(body.error.code).toBe('DOC_UPLOAD_EMPTY')
    expect(body.error.message).toBe('Filen är tom. Ladda upp filen igen.')
  })

  it('replaces an internal English failure with the registry copy', async () => {
    vi.mocked(completePendingDocumentUpload).mockRejectedValueOnce(
      new Error('Failed to finalize document upload: move failed'),
    )
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: null })

    const res = await completeRoute.handler(
      createMockRequest('/upload/complete', { method: 'POST', body: completeBody() }),
      buildCtx(mock.supabase),
    )
    const { status, body } = await parseJsonResponse<Envelope>(res)

    expect(status).toBe(500)
    expect(body.error.code).toBe('INBOX_UPLOAD_FAILED')
    expect(body.error.message).toBe('Uppladdningen misslyckades. Försök igen.')
    expect(body.error.message_en).not.toContain('move failed')
  })
})
