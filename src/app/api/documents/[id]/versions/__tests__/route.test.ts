import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, reset } = createQueuedMockSupabase()

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

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const mockCreateNewVersion = vi.fn()
const mockValidateDocumentFile = vi.fn()
vi.mock('@/lib/core/documents/document-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/core/documents/document-service')>()
  return {
    DOCUMENTS_BUCKET: actual.DOCUMENTS_BUCKET,
    buildPendingDocumentStoragePath: actual.buildPendingDocumentStoragePath,
    createNewVersion: (...args: unknown[]) => mockCreateNewVersion(...args),
    validateDocumentFile: (...args: unknown[]) => mockValidateDocumentFile(...args),
  }
})

// The service-role Storage client readUploadedFile reads a staged upload with.
const stagedDownload = vi.fn()
const stagedRemove = vi.fn()
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => ({
    storage: { from: () => ({ download: stagedDownload, remove: stagedRemove }) },
  }),
}))

import { POST } from '../route'
import { requireWritePermission } from '@/lib/auth/require-write'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function makeReq(withFile = true) {
  const form = new FormData()
  if (withFile) {
    form.append('file', new File(['content'], 'kvitto.pdf', { type: 'application/pdf' }))
  }
  return new Request('http://localhost/api/documents/doc-1/versions', {
    method: 'POST',
    body: form,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: mockUser, supabase: mockSupabase, error: null })
  vi.mocked(requireWritePermission).mockResolvedValue({ ok: true })
  mockValidateDocumentFile.mockReturnValue(null)
})

describe('POST /api/documents/[id]/versions', () => {
  // A phone photo or scan over the hosted body cap arrives staged in Storage.
  it('versions a file staged in Storage like an inline one', async () => {
    const uploadId = '33333333-3333-4333-8333-333333333333'
    stagedDownload.mockResolvedValue({ data: new Blob([new TextEncoder().encode('%PDF-1.4 v2')]), error: null })
    stagedRemove.mockResolvedValue({ data: [], error: null })
    mockCreateNewVersion.mockResolvedValue({ id: 'doc-2', version: 2 })
    const form = new FormData()
    form.append('upload_id', uploadId)
    form.append('file_name', 'kvitto.pdf')
    form.append('mime_type', 'application/pdf')

    const res = await POST(
      new Request('http://localhost/api/documents/doc-1/versions', { method: 'POST', body: form }),
      createMockRouteParams({ id: 'doc-1' }),
    )

    expect(res.status).toBe(200)
    expect(stagedDownload).toHaveBeenCalledWith(`documents/company-1/user-1/pending/${uploadId}_kvitto.pdf`)
    const [, , docId, file] = mockCreateNewVersion.mock.calls[0]
    expect(docId).toBe('doc-1')
    expect(file).toEqual(expect.objectContaining({ name: 'kvitto.pdf', type: 'application/pdf' }))
  })

  it('returns 404 when the staged file is not in Storage', async () => {
    stagedDownload.mockResolvedValue({ data: null, error: { message: 'Object not found' } })
    const form = new FormData()
    form.append('upload_id', '33333333-3333-4333-8333-333333333333')
    form.append('file_name', 'kvitto.pdf')
    form.append('mime_type', 'application/pdf')

    const res = await POST(
      new Request('http://localhost/api/documents/doc-1/versions', { method: 'POST', body: form }),
      createMockRouteParams({ id: 'doc-1' }),
    )
    const { status, body } = await parseJsonResponse<{ error: string }>(res)

    expect(status).toBe(404)
    expect(body.error).toContain('Ladda upp filen igen')
    expect(mockCreateNewVersion).not.toHaveBeenCalled()
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 403 when caller has read-only role', async () => {
    vi.mocked(requireWritePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { error: 'Du har endast läsbehörighet i detta företag.' },
        { status: 403 },
      ),
    })
    const res = await POST(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(403)
    expect(mockCreateNewVersion).not.toHaveBeenCalled()
  })

  it('returns 400 when no file is provided', async () => {
    const res = await POST(makeReq(false), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(400)
    expect(body.error).toBe('No file provided')
  })

  it('creates a new version on the happy path', async () => {
    mockCreateNewVersion.mockResolvedValue({ id: 'doc-2', version: 2 })
    const res = await POST(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{ data: { id: string; version: number } }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual({ id: 'doc-2', version: 2 })
    expect(mockCreateNewVersion).toHaveBeenCalledWith(
      mockSupabase,
      'user-1',
      'doc-1',
      expect.objectContaining({ name: 'kvitto.pdf', type: 'application/pdf' }),
    )
  })
})
