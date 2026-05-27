import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import {
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
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

import { DELETE } from '../route'
import { requireWritePermission } from '@/lib/auth/require-write'
import { NextResponse } from 'next/server'

const mockUser = { id: 'user-1', email: 'test@test.se' }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  eventBus.clear()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  // Reset write-permission mock to default ok
  vi.mocked(requireWritePermission).mockResolvedValue({ ok: true })
})

function makeReq() {
  return new Request('http://localhost/api/documents/doc-1', { method: 'DELETE' })
}

describe('DELETE /api/documents/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
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

    expect(mockSupabase.storage.from).toHaveBeenCalledWith('documents')
    const storageBucket = mockSupabase.storage.from.mock.results[0]?.value
    expect(storageBucket.remove).toHaveBeenCalledWith(['documents/user-1/kvitto.pdf'])

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
