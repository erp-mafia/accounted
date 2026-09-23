/**
 * Tests for POST /api/documents (upload to the WORM archive).
 *
 * Covers: 401, 400 (no file, unsupported type, content validation, locked
 * period), 500 on a storage failure, and the happy path. The happy path pins
 * the contract this route has with uploadDocument: the response is the stored
 * row, and document.uploaded subscribers run after the response rather than
 * inside it (they include a model call that measured p50 14 s on production).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRouteParams,
  createQueuedMockSupabase,
  makeDocumentAttachment,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const uploadDocumentMock = vi.fn()
vi.mock('@/lib/core/documents/document-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/core/documents/document-service')>(
    '@/lib/core/documents/document-service',
  )
  return { ...actual, uploadDocument: (...args: unknown[]) => uploadDocumentMock(...args) }
})

import { POST } from '../route'

const JE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function pdf(name = 'kvitto.pdf', type = 'application/pdf'): File {
  return new File([new TextEncoder().encode('%PDF-1.4\nreceipt\n%%EOF\n')], name, { type })
}

function makeRequest(fields: Record<string, string | File>): Request {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  return new Request('http://localhost/api/documents', { method: 'POST', body: form })
}

describe('POST /api/documents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when the caller is not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const res = await POST(makeRequest({ file: pdf() }) as never, createMockRouteParams({}))

    expect(res.status).toBe(401)
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('returns 400 when no file is sent', async () => {
    const res = await POST(makeRequest({ upload_source: 'file_upload' }) as never, createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBe(400)
    expect(body.error.code).toBe('DOC_UPLOAD_NO_FILE')
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('returns 400 for a file type the archive does not accept', async () => {
    const res = await POST(makeRequest({ file: pdf('run.exe', 'application/x-msdownload') }) as never, createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBe(400)
    expect(body.error.code).toBe('DOC_UPLOAD_UNSUPPORTED_TYPE')
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('returns 400 when the bytes do not match the declared type', async () => {
    uploadDocumentMock.mockRejectedValue(new Error('Filen matchar inte den angivna filtypen'))

    const res = await POST(makeRequest({ file: pdf() }) as never, createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBe(400)
    expect(body.error.code).toBe('DOC_UPLOAD_INVALID_CONTENT')
  })

  it('returns 400 when the target verifikat sits in a locked period', async () => {
    uploadDocumentMock.mockRejectedValue(new Error('Cannot attach to a locked/closed fiscal period'))

    const res = await POST(makeRequest({ file: pdf(), journal_entry_id: JE_ID }) as never, createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBe(400)
    expect(body.error.code).toBe('DOC_UPLOAD_PERIOD_LOCKED')
  })

  it('returns 500 with a generic code when storage fails, without leaking the raw message', async () => {
    uploadDocumentMock.mockRejectedValue(new Error('Failed to upload document: bucket internals'))

    const res = await POST(makeRequest({ file: pdf() }) as never, createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBe(500)
    expect(body.error.code).toBe('DOC_UPLOAD_STORAGE_FAILED')
    expect(JSON.stringify(body)).not.toContain('bucket internals')
  })

  it('stores the file, returns the row, and leaves document.uploaded subscribers for after the response', async () => {
    const stored = makeDocumentAttachment({ id: 'doc-1', file_name: 'kvitto.pdf', journal_entry_id: JE_ID })
    uploadDocumentMock.mockResolvedValue(stored)

    const res = await POST(makeRequest({ file: pdf(), journal_entry_id: JE_ID }) as never, createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ data: { id: string } }>(res)

    expect(status).toBe(200)
    expect(body.data.id).toBe('doc-1')
    expect(uploadDocumentMock).toHaveBeenCalledOnce()
    const [, userId, companyId, file, metadata] = uploadDocumentMock.mock.calls[0]
    expect(userId).toBe('user-1')
    expect(companyId).toBe('company-1')
    expect(file).toEqual(expect.objectContaining({ name: 'kvitto.pdf', type: 'application/pdf' }))
    expect(metadata).toEqual({
      upload_source: 'file_upload',
      journal_entry_id: JE_ID,
      journal_entry_line_id: undefined,
      deferUploadedEvent: true,
    })
  })

  it('falls back to file_upload for an upload_source outside the whitelist', async () => {
    uploadDocumentMock.mockResolvedValue(makeDocumentAttachment({ id: 'doc-2' }))

    await POST(makeRequest({ file: pdf(), upload_source: 'anything-goes' }) as never, createMockRouteParams({}))

    expect(uploadDocumentMock.mock.calls[0][4]).toEqual(
      expect.objectContaining({ upload_source: 'file_upload' }),
    )
  })
})
