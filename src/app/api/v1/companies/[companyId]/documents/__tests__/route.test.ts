/**
 * Tests for POST /api/v1/companies/:companyId/documents (API-key upload).
 *
 * Covers: 401, 400 (missing Idempotency-Key, missing file, bad upload_source),
 * 404 for a journal_entry_id outside the caller's company, and the happy path.
 * The happy path pins two contracts: the public response carries row fields
 * only (no storage_path, no extraction fields), and document.uploaded
 * subscribers run after the response. No v1 read exposes extraction, so no
 * client can observe the subscribers' timing; awaiting them held the 201 for
 * the length of a model call.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDocumentAttachment } from '@/tests/helpers'

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
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const JE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const URL = `https://x.test/api/v1/companies/${COMPANY_ID}/documents`

/** Every table answers from `byTable`; anything unlisted answers empty. */
function makeFlexibleSupabase(byTable: Record<string, { data?: unknown; error?: unknown }>) {
  const buildChain = (table: string): unknown =>
    new Proxy({}, {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve(byTable[table] ?? { data: null, error: null })
        }
        return () => buildChain(table)
      },
    })
  return { from: vi.fn((table: string) => buildChain(table)) }
}

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
  mockServiceClient.mockReturnValue(makeFlexibleSupabase(MEMBER))
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

  it('returns 404 when journal_entry_id does not belong to the company', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({ ...MEMBER, journal_entries: { data: null, error: null } }),
    )

    const res = await POST(makeUpload({ file: pdf(), journal_entry_id: JE_ID }), params())
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('stores the file, answers 201 with row fields only, and defers document.uploaded subscribers', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({ ...MEMBER, journal_entries: { data: { id: JE_ID }, error: null } }),
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
      deferUploadedEvent: true,
    })
  })
})
