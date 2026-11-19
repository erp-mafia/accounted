/**
 * Tests for POST /api/documents/uploads (reserve a direct-to-Storage upload).
 *
 * Covers: 401, 400 on a malformed body, 400 for a file over the archive's
 * ceiling or of a type it does not take (refused before any URL exists), 500
 * when Storage will not sign, and the happy path: the raw signed URL, keyed on
 * the session's company and user.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRouteParams, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

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

const createPendingMock = vi.fn()
vi.mock('@/lib/core/documents/document-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/core/documents/document-service')>(
    '@/lib/core/documents/document-service',
  )
  return { ...actual, createPendingDocumentUpload: (...args: unknown[]) => createPendingMock(...args) }
})

import { POST } from '../route'

const SIGNED_URL = 'https://proj.supabase.co/storage/v1/object/upload/sign/documents/x.pdf?token=t'

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/documents/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const valid = { file_name: 'årsredovisning.pdf', mime_type: 'application/pdf', size_bytes: 6 * 1024 * 1024 }

describe('POST /api/documents/uploads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    createPendingMock.mockImplementation(async (_s, _c, _u, uploadId: string) => ({
      uploadId,
      signedUrl: SIGNED_URL,
      expiresAt: '2026-10-28T14:00:00.000Z',
    }))
  })

  it('returns 401 when the caller is not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const res = await POST(makeRequest(valid) as never, createMockRouteParams({}))

    expect(res.status).toBe(401)
    expect(createPendingMock).not.toHaveBeenCalled()
  })

  it('returns 400 for a malformed body', async () => {
    const res = await POST(makeRequest({ file_name: '', size_bytes: 0 }) as never, createMockRouteParams({}))

    expect(res.status).toBe(400)
    expect(createPendingMock).not.toHaveBeenCalled()
  })

  it('refuses a file over the archive ceiling before any URL is signed', async () => {
    const res = await POST(makeRequest({ ...valid, size_bytes: 11 * 1024 * 1024 }) as never, createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBe(400)
    expect(body.error.code).toBe('DOC_UPLOAD_TOO_LARGE')
    expect(createPendingMock).not.toHaveBeenCalled()
  })

  it('refuses a type the archive does not take', async () => {
    const res = await POST(
      makeRequest({ ...valid, file_name: 'run.exe', mime_type: 'application/x-msdownload' }) as never,
      createMockRouteParams({}),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBe(400)
    expect(body.error.code).toBe('DOC_UPLOAD_UNSUPPORTED_TYPE')
  })

  it('takes a HEIC with no declared type by its extension, as the upload route does', async () => {
    const res = await POST(
      makeRequest({ file_name: 'IMG_0001.HEIC', mime_type: '', size_bytes: 6 * 1024 * 1024 }) as never,
      createMockRouteParams({}),
    )

    expect(res.status).toBe(200)
  })

  it('answers the raw signed URL for a reservation keyed on the session company and user', async () => {
    const res = await POST(makeRequest(valid) as never, createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{
      data: { upload_id: string; upload_url: string; expires_at: string }
    }>(res)

    expect(status).toBe(200)
    expect(body.data.upload_url).toBe(SIGNED_URL)
    expect(body.data.upload_id).toMatch(/^[0-9a-f-]{36}$/)
    const [, companyId, userId, uploadId, fileName] = createPendingMock.mock.calls[0]
    expect(companyId).toBe('company-1')
    expect(userId).toBe('user-1')
    expect(uploadId).toBe(body.data.upload_id)
    expect(fileName).toBe('årsredovisning.pdf')
  })

  it('returns 500 with a generic code when Storage will not sign', async () => {
    createPendingMock.mockRejectedValue(new Error('Failed to create document upload URL: bucket internals'))

    const res = await POST(makeRequest(valid) as never, createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)

    expect(status).toBe(500)
    expect(body.error.code).toBe('DOC_UPLOAD_STORAGE_FAILED')
    expect(JSON.stringify(body)).not.toContain('bucket internals')
  })
})
