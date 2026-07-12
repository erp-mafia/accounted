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
vi.mock('@/lib/core/documents/document-service', () => ({
  createNewVersion: (...args: unknown[]) => mockCreateNewVersion(...args),
  validateDocumentFile: (...args: unknown[]) => mockValidateDocumentFile(...args),
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
