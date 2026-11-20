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

const { supabase, reset, enqueue, findCall } = createQueuedMockSupabase()

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

// The service-role Storage client readUploadedFile reads a staged upload with.
const stagedDownload = vi.fn()
const stagedRemove = vi.fn()
vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    createServiceClientNoCookies: () => ({
      storage: { from: () => ({ download: stagedDownload, remove: stagedRemove }) },
    }),
  }
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

  it('accepts a CSV that Windows declares as Excel and stores it as text/csv (crm#268)', async () => {
    uploadDocumentMock.mockResolvedValue(makeDocumentAttachment({ id: 'doc-csv', file_name: 'export.csv' }))
    const csv = new File([new TextEncoder().encode('datum;belopp\n2026-10-01;100\n')], 'export.csv', {
      type: 'application/vnd.ms-excel',
    })

    const res = await POST(makeRequest({ file: csv }) as never, createMockRouteParams({}))

    expect(res.status).toBe(200)
    const [, , , file] = uploadDocumentMock.mock.calls[0]
    expect(file).toEqual(expect.objectContaining({ name: 'export.csv', type: 'text/csv' }))
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
      linkBasis: { link_basis: 'user_confirmed', link_evidence: null },
      deferUploadedEvent: true,
    })
  })

  it('asks for the content dedupe when the free-floating Arkiv drop sends dedupe_by_content', async () => {
    uploadDocumentMock.mockResolvedValue(makeDocumentAttachment({ id: 'doc-3' }))

    const res = await POST(makeRequest({ file: pdf(), dedupe_by_content: 'true' }) as never, createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)

    expect(status).toBe(200)
    expect(uploadDocumentMock.mock.calls[0][4]).toEqual(expect.objectContaining({ dedupeByContent: true }))
    expect(body.data.id).toBe('doc-3')
    expect(body.data).not.toHaveProperty('deduplicated')
    expect(body.data).not.toHaveProperty('duplicate_of')
  })

  it('answers the archived document with deduplicated and duplicate_of when the bytes already sit in Underlag', async () => {
    uploadDocumentMock.mockResolvedValue({ ...makeDocumentAttachment({ id: 'doc-old', journal_entry_id: null }), deduplicated: true })
    enqueue({ data: [{ id: 'item-1' }] })

    const res = await POST(makeRequest({ file: pdf(), dedupe_by_content: 'true' }) as never, createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)

    expect(status).toBe(200)
    expect(body.data).toMatchObject({ id: 'doc-old', deduplicated: true, duplicate_of: 'doc-old' })
    expect(uploadDocumentMock).toHaveBeenCalledOnce()
    expect(findCall('invoice_inbox_items', 'eq')).toEqual(['company_id', 'company-1'])
  })

  it('answers the archived document when a verifikat already holds it, without looking for an inbox item', async () => {
    uploadDocumentMock.mockResolvedValue({ ...makeDocumentAttachment({ id: 'doc-booked', journal_entry_id: JE_ID }), deduplicated: true })

    const res = await POST(makeRequest({ file: pdf(), dedupe_by_content: 'true' }) as never, createMockRouteParams({}))
    const { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)

    expect(body.data).toMatchObject({ id: 'doc-booked', journal_entry_id: JE_ID, deduplicated: true, duplicate_of: 'doc-booked' })
    expect(findCall('invoice_inbox_items', 'select')).toBeUndefined()
    expect(uploadDocumentMock).toHaveBeenCalledOnce()
  })

  it.each([
    ['no inbox item carries it', { data: [] }],
    ['the inbox lookup fails', { error: { message: 'boom' } }],
  ])('stores the upload again when the archived copy reached nothing (%s): Arkiv left it out of Underlag', async (_label, lookup) => {
    uploadDocumentMock
      .mockResolvedValueOnce({ ...makeDocumentAttachment({ id: 'doc-orphan', journal_entry_id: null }), deduplicated: true })
      .mockResolvedValueOnce(makeDocumentAttachment({ id: 'doc-new' }))
    enqueue(lookup)

    const res = await POST(makeRequest({ file: pdf(), dedupe_by_content: 'true' }) as never, createMockRouteParams({}))
    const { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(res)

    expect(body.data.id).toBe('doc-new')
    expect(body.data).not.toHaveProperty('deduplicated')
    expect(uploadDocumentMock).toHaveBeenCalledTimes(2)
    expect(uploadDocumentMock.mock.calls[0][4]).toEqual(expect.objectContaining({ dedupeByContent: true }))
    expect(uploadDocumentMock.mock.calls[1][4]).not.toHaveProperty('dedupeByContent')
  })

  it.each([
    ['a verifikat', { journal_entry_id: JE_ID }],
    ['a line', { journal_entry_line_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }],
  ])('never dedupes an upload that names %s: the same underlag sits on several verifikat as one copy each', async (_label, target) => {
    uploadDocumentMock.mockResolvedValue(makeDocumentAttachment({ id: 'doc-4', journal_entry_id: JE_ID }))

    await POST(makeRequest({ file: pdf(), dedupe_by_content: 'true', ...target }) as never, createMockRouteParams({}))

    expect(uploadDocumentMock.mock.calls[0][4]).not.toHaveProperty('dedupeByContent')
  })

  it('leaves the dedupe off unless asked for, as the verifikat attachment zone and the supplier invoice form upload', async () => {
    uploadDocumentMock.mockResolvedValue(makeDocumentAttachment({ id: 'doc-5' }))

    await POST(makeRequest({ file: pdf(), upload_source: 'file_upload' }) as never, createMockRouteParams({}))
    await POST(makeRequest({ file: pdf(), dedupe_by_content: 'yes' }) as never, createMockRouteParams({}))

    expect(uploadDocumentMock.mock.calls[0][4]).not.toHaveProperty('dedupeByContent')
    expect(uploadDocumentMock.mock.calls[1][4]).not.toHaveProperty('dedupeByContent')
  })

  it('falls back to file_upload for an upload_source outside the whitelist', async () => {
    uploadDocumentMock.mockResolvedValue(makeDocumentAttachment({ id: 'doc-2' }))

    await POST(makeRequest({ file: pdf(), upload_source: 'anything-goes' }) as never, createMockRouteParams({}))

    expect(uploadDocumentMock.mock.calls[0][4]).toEqual(
      expect.objectContaining({ upload_source: 'file_upload' }),
    )
  })
  // Over the hosted body cap the browser stages the file in Storage first
  // (POST /api/documents/uploads) and sends a reference instead of the bytes.
  it('archives a file staged in Storage exactly like an inline one', async () => {
    const UPLOAD_ID = '33333333-3333-4333-8333-333333333333'
    const bytes = new TextEncoder().encode('%PDF-1.4\nbig scan\n%%EOF\n')
    stagedDownload.mockResolvedValue({ data: new Blob([bytes]), error: null })
    stagedRemove.mockResolvedValue({ data: [], error: null })
    uploadDocumentMock.mockResolvedValue(makeDocumentAttachment({ id: 'doc-big', journal_entry_id: JE_ID }))

    const res = await POST(
      makeRequest({ upload_id: UPLOAD_ID, file_name: 'skanning.pdf', mime_type: 'application/pdf', journal_entry_id: JE_ID }) as never,
      createMockRouteParams({}),
    )

    expect(res.status).toBe(200)
    expect(stagedDownload).toHaveBeenCalledWith(`documents/company-1/user-1/pending/${UPLOAD_ID}_skanning.pdf`)
    const [, , , file, metadata] = uploadDocumentMock.mock.calls[0]
    expect(file).toEqual(expect.objectContaining({ name: 'skanning.pdf', type: 'application/pdf' }))
    expect(new Uint8Array(file.buffer)).toEqual(bytes)
    expect(metadata).toEqual(expect.objectContaining({ journal_entry_id: JE_ID }))
  })

  it('returns 404 when the staged file is not in Storage', async () => {
    stagedDownload.mockResolvedValue({ data: null, error: { message: 'Object not found' } })

    const res = await POST(
      makeRequest({ upload_id: '33333333-3333-4333-8333-333333333333', file_name: 'skanning.pdf', mime_type: 'application/pdf' }) as never,
      createMockRouteParams({}),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBe(404)
    expect(body.error.code).toBe('DOCUMENT_UPLOAD_NOT_FOUND')
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })
})
