/**
 * Tests for POST /api/v1/companies/:companyId/documents (API-key upload).
 *
 * Covers: 401, 400 (missing Idempotency-Key, missing file, bad upload_source),
 * 404 for a journal_entry_id outside the caller's company, 400 for one in a
 * locked or closed year (it was a 500), and the happy path.
 * The happy path pins two contracts: the public response carries row fields
 * only (no storage_path, no extraction fields), and document.uploaded
 * subscribers run after the response. No v1 read exposes extraction, so no
 * client can observe the subscribers' timing; awaiting them held the 201 for
 * the length of a model call.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDocumentAttachment, createTableMockSupabase } from '@/tests/helpers'

beforeAll(() => {
  // Never reach a real DB from this suite: clients are mocked, and this
  // fails the run if a refactor ever bypasses the mock.
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `documents route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
    )
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

const uploadDocumentMock = vi.fn()
vi.mock('@/lib/core/documents/document-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/core/documents/document-service')>(
    '@/lib/core/documents/document-service',
  )
  return { ...actual, uploadDocument: (...args: unknown[]) => uploadDocumentMock(...args) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const JE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const URL = `https://x.test/api/v1/companies/${COMPANY_ID}/documents`

const MEMBER = { company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null } }

function pdf(): File {
  return new File([new TextEncoder().encode('%PDF-1.4\nreceipt\n%%EOF\n')], 'kvitto.pdf', {
    type: 'application/pdf',
  })
}

function makeUpload(
  fields: Record<string, string | File>,
  headers: Record<string, string> = { 'Idempotency-Key': 'abcd1234-1111-4abc-8def-1234567890ab' },
): Request {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  return new Request(URL, {
    method: 'POST',
    body: form,
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key', ...headers },
  })
}

const params = () => ({ params: Promise.resolve({ companyId: COMPANY_ID }) })

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['documents:write'],
    mode: 'live',
  })
  mockServiceClient.mockReturnValue(createTableMockSupabase(MEMBER).supabase)
})

describe('POST /api/v1/companies/:companyId/documents', () => {
  it('returns 401 when the API key is not valid', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key' })

    const res = await POST(makeUpload({ file: pdf() }), params())

    expect(res.status).toBe(401)
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('returns 400 without an Idempotency-Key header', async () => {
    const res = await POST(makeUpload({ file: pdf() }, {}), params())
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('returns 400 when the multipart body has no file part', async () => {
    const res = await POST(makeUpload({ upload_source: 'api' }), params())
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('DOC_UPLOAD_NO_FILE')
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('returns 400 for an upload_source outside the enum', async () => {
    const res = await POST(makeUpload({ file: pdf(), upload_source: 'system' }), params())
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  // The archive is WORM: a "preview" that stored the file could not be undone.
  it.each([
    ['?dry_run=true', `${URL}?dry_run=true`, {}],
    ['X-Dry-Run: true', URL, { 'X-Dry-Run': 'true' }],
  ])('refuses a dry run (%s) with 400 and stores nothing', async (_label, url, extra) => {
    const form = new FormData()
    form.append('file', pdf())
    const res = await POST(
      new Request(url, {
        method: 'POST',
        body: form,
        headers: {
          Authorization: 'Bearer test-fixture-not-a-real-key',
          'Idempotency-Key': 'abcd1234-2222-4abc-8def-1234567890ab',
          ...extra,
        },
      }),
      params(),
    )
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('dry_run')
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('returns 404 when journal_entry_id does not belong to the company', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({ ...MEMBER, journal_entries: { data: null, error: null } }).supabase,
    )

    const res = await POST(makeUpload({ file: pdf(), journal_entry_id: JE_ID }), params())
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('stores the file, answers 201 with row fields only, and defers document.uploaded subscribers', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({ ...MEMBER, journal_entries: { data: { id: JE_ID }, error: null } }).supabase,
    )
    uploadDocumentMock.mockResolvedValue(
      makeDocumentAttachment({
        id: 'doc-1',
        file_name: 'kvitto.pdf',
        journal_entry_id: JE_ID,
        storage_path: 'documents/company/user/kvitto.pdf',
      }),
    )

    const res = await POST(makeUpload({ file: pdf(), journal_entry_id: JE_ID }), params())
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.data.id).toBe('doc-1')
    expect(body.data.journal_entry_id).toBe(JE_ID)
    // Internal layout and extraction state stay out of the public surface.
    expect(body.data).not.toHaveProperty('storage_path')
    expect(body.data).not.toHaveProperty('extracted_data')
    expect(body.data).not.toHaveProperty('extracted_at')

    expect(uploadDocumentMock).toHaveBeenCalledOnce()
    const [, userId, companyId, , metadata] = uploadDocumentMock.mock.calls[0]
    expect(userId).toBe('user-1')
    expect(companyId).toBe(COMPANY_ID)
    expect(metadata).toEqual({
      upload_source: 'file_upload',
      journal_entry_id: JE_ID,
      journal_entry_line_id: undefined,
      // An API key named the verifikat: nobody approved it in Accounted.
      linkBasis: { link_basis: 'client_asserted', link_evidence: null },
      deferUploadedEvent: true,
      // Linked on arrival: the verifikat is the booking, no model pass.
      extractionOwner: 'none',
    })
  })

  it('leaves extraction on for a document that is not linked to a verifikat', async () => {
    mockServiceClient.mockReturnValue(createTableMockSupabase({ ...MEMBER }).supabase)
    uploadDocumentMock.mockResolvedValue(
      makeDocumentAttachment({ id: 'doc-2', file_name: 'kvitto.pdf', journal_entry_id: null }),
    )

    const res = await POST(makeUpload({ file: pdf() }), params())

    expect(res.status).toBe(201)
    expect(uploadDocumentMock).toHaveBeenCalledOnce()
    const [, , , , metadata] = uploadDocumentMock.mock.calls[0]
    expect(metadata).not.toHaveProperty('extractionOwner')
    expect(metadata.deferUploadedEvent).toBe(true)
  })

  it('records the upload as a partner_api arrival pointing at the stored document', async () => {
    const DOC_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const db = createTableMockSupabase({
      ...MEMBER,
      document_attachments: {
        data: { id: DOC_ID, storage_path: 'documents/x/y/kvitto.pdf', sha256_hash: 'e'.repeat(64), mime_type: 'application/pdf', file_size_bytes: 24, file_name: 'kvitto.pdf' },
      },
      arrivals: (calls) => {
        const upsert = calls.find((c) => c.method === 'upsert')
        return upsert ? { data: [{ ...(upsert.args[0] as Record<string, unknown>), created_at: '2026-10-15T08:00:00Z' }] } : { data: null }
      },
      arrival_outputs: { data: null },
    })
    mockServiceClient.mockReturnValue(db.supabase)
    uploadDocumentMock.mockResolvedValue(makeDocumentAttachment({ id: DOC_ID, file_name: 'kvitto.pdf', journal_entry_id: null }))

    const res = await POST(makeUpload({ file: pdf() }), params())

    expect(res.status).toBe(201)
    const [arrival] = db.payloads('arrivals', 'upsert') as Array<Record<string, unknown>>
    expect(arrival).toMatchObject({
      company_id: COMPANY_ID,
      source: 'partner_api',
      source_ref: DOC_ID,
      original_path: 'documents/x/y/kvitto.pdf',
      fetched_by: { type: 'api_key', user_id: 'user-1', api_key_id: 'ak_1' },
      source_meta: { document_id: DOC_ID, file_name: 'kvitto.pdf', idempotency_key: 'abcd1234-1111-4abc-8def-1234567890ab' },
    })
  })

  it('answers 201 even when the arrival cannot be recorded', async () => {
    const DOC_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({ ...MEMBER, document_attachments: { data: null, error: { message: 'boom' } } }).supabase,
    )
    uploadDocumentMock.mockResolvedValue(makeDocumentAttachment({ id: DOC_ID, file_name: 'kvitto.pdf', journal_entry_id: null }))

    const res = await POST(makeUpload({ file: pdf() }), params())
    expect(res.status).toBe(201)
  })

  it.each([
    ['no dedupe_by_content', {}],
    ['dedupe_by_content=false', { dedupe_by_content: 'false' }],
  ])('stores every upload as its own row by default (%s), as before the dedupe existed', async (_label, fields) => {
    mockServiceClient.mockReturnValue(createTableMockSupabase({ ...MEMBER }).supabase)
    uploadDocumentMock.mockResolvedValue(makeDocumentAttachment({ id: 'doc-3', journal_entry_id: null }))

    const res = await POST(makeUpload({ file: pdf(), ...fields }), params())
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(uploadDocumentMock.mock.calls[0][4]).not.toHaveProperty('dedupeByContent')
    expect(body.data).not.toHaveProperty('deduplicated')
    expect(body.data).not.toHaveProperty('duplicate_of')
  })

  it('asks for the content dedupe when the caller opts in on an upload that names no verifikat', async () => {
    mockServiceClient.mockReturnValue(createTableMockSupabase({ ...MEMBER }).supabase)
    uploadDocumentMock.mockResolvedValue(makeDocumentAttachment({ id: 'doc-5', journal_entry_id: null }))

    const res = await POST(makeUpload({ file: pdf(), dedupe_by_content: 'true' }), params())
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(uploadDocumentMock.mock.calls[0][4]).toEqual(expect.objectContaining({ dedupeByContent: true }))
    expect(body.data).not.toHaveProperty('deduplicated')
  })

  it('returns 400 for a dedupe_by_content that is not true or false', async () => {
    const res = await POST(makeUpload({ file: pdf(), dedupe_by_content: 'yes' }), params())
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('answers the archived document with deduplicated and duplicate_of when the bytes are already there', async () => {
    mockServiceClient.mockReturnValue(createTableMockSupabase({ ...MEMBER }).supabase)
    uploadDocumentMock.mockResolvedValue({
      ...makeDocumentAttachment({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', journal_entry_id: JE_ID }),
      deduplicated: true,
    })

    const res = await POST(makeUpload({ file: pdf(), dedupe_by_content: 'true' }), params())
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.data).toMatchObject({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      journal_entry_id: JE_ID,
      deduplicated: true,
      duplicate_of: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    })
  })

  // Production 2026-11-16: an integration's PDF named a verifikat in a closed
  // year, enforce_period_lock_documents refused the row, and the caller got
  // 500 DOC_UPLOAD_STORAGE_FAILED with no reason and no way forward. Runs the
  // real uploadDocument against the database's own refusal text.
  it('answers 400 DOC_UPLOAD_PERIOD_LOCKED with the reason and the way forward when the verifikat is in a locked or closed year', async () => {
    const actual = await vi.importActual<typeof import('@/lib/core/documents/document-service')>(
      '@/lib/core/documents/document-service',
    )
    uploadDocumentMock.mockImplementation(actual.uploadDocument)
    const upload = vi.fn().mockResolvedValue({ data: {}, error: null })
    const remove = vi.fn().mockResolvedValue({ data: [], error: null })
    const db = createTableMockSupabase({
      ...MEMBER,
      journal_entries: { data: { id: JE_ID }, error: null },
      document_attachments: {
        data: null,
        error: { code: 'P0001', message: 'Cannot attach documents to entries in a locked/closed fiscal period' },
      },
    })
    mockServiceClient.mockReturnValue({
      ...db.supabase,
      storage: {
        getBucket: vi.fn().mockResolvedValue({ data: { id: 'documents' }, error: null }),
        from: vi.fn().mockReturnValue({ upload, remove }),
      },
    })

    const res = await POST(makeUpload({ file: pdf(), journal_entry_id: JE_ID }), params())
    const body = await res.json()

    const answer = getErrorEntry('DOC_UPLOAD_PERIOD_LOCKED')!
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('DOC_UPLOAD_PERIOD_LOCKED')
    expect(body.error.message).toBe(answer.message_sv)
    expect(body.error.message).toContain('Lås upp året eller öppna det igen under Inställningar → Bokföring → Räkenskapsår')
    expect(body.error.message_en).toBe(answer.message_en)
    expect(body.error.recovery_hint).toBe(answer.remediation!.description)
    expect(JSON.stringify(body)).not.toContain('Cannot attach')
    // Nothing stays behind: the object the upload wrote is removed again.
    expect(remove).toHaveBeenCalledWith([upload.mock.calls[0][0]])
    expect(db.payloads('arrivals', 'upsert')).toEqual([])
  })

  it('still answers 500 DOC_UPLOAD_STORAGE_FAILED for a failure that is no refusal', async () => {
    mockServiceClient.mockReturnValue(createTableMockSupabase({ ...MEMBER }).supabase)
    uploadDocumentMock.mockRejectedValue(new Error('Failed to upload document: socket closed'))

    const res = await POST(makeUpload({ file: pdf() }), params())
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error.code).toBe('DOC_UPLOAD_STORAGE_FAILED')
  })

  it('ignores dedupe_by_content on an upload that names a verifikat: the same underlag sits on several verifikat as one copy each', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({ ...MEMBER, journal_entries: { data: { id: JE_ID }, error: null } }).supabase,
    )
    uploadDocumentMock.mockResolvedValue(makeDocumentAttachment({ id: 'doc-4', journal_entry_id: JE_ID }))

    const res = await POST(makeUpload({ file: pdf(), journal_entry_id: JE_ID, dedupe_by_content: 'true' }), params())

    expect(res.status).toBe(201)
    expect(uploadDocumentMock.mock.calls[0][4]).not.toHaveProperty('dedupeByContent')
  })
})
