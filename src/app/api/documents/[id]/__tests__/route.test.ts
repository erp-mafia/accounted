import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import {
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeDocumentAttachment,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

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
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(404)
    expect(body.error).toContain('hittades inte')
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
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(409)
    expect(body.error).toContain('Bokföringslagen')
    expect(body.error).toContain('7 kap')
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
    enqueue({
      data: null,
      error: { message: 'Cannot delete document linked to a posted journal entry (Bokföringslagen)' },
    })

    const res = await DELETE(makeReq(), createMockRouteParams({ id: 'doc-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(res)
    expect(status).toBe(409)
    expect(body.error).toContain('Bokföringslagen')
  })
})
