import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const {
  supabase: archiveSupabase,
  enqueue: enqueueArchive,
  reset: resetArchive,
  calls: archiveCalls,
} = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(supabase),
  createServiceClient: () => archiveSupabase,
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/reports/full-archive-export', () => ({
  estimateArchiveSize: vi.fn(),
  generateBaseDataArchive: vi.fn(),
}))

import {
  estimateArchiveSize,
  generateBaseDataArchive,
} from '@/lib/reports/full-archive-export'
import { GET } from '../route'

const mockEstimate = vi.mocked(estimateArchiveSize)
const mockGenerate = vi.mocked(generateBaseDataArchive)
const params = { params: Promise.resolve({ id: 'company-1' }) }

function enqueueAuthorizedArchive() {
  enqueue({ data: { role: 'owner' }, error: null })
  enqueue({
    data: { source_company_id: 'source-1', created_at: '2026-08-18T14:00:00.000Z' },
    error: null,
  })
  enqueueArchive({
    data: { source_company_id: 'source-1', created_at: '2026-08-18T14:00:00.000Z' },
    error: null,
  })
  enqueueArchive({ data: { role: 'owner' }, error: null })
  enqueueArchive({ data: { archived_at: '2026-08-18T14:00:00.000Z' }, error: null })
}

describe('GET /api/company/[id]/migration-reset/archive', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    resetArchive()
    supabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'owner@example.com' } },
      error: null,
    })
    mockEstimate.mockResolvedValue({
      total_bytes: 10_000_000,
      document_bytes: 1_000_000,
      document_count: 2,
    })
  })

  it('returns 401 when unauthenticated', async () => {
    supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })

    const response = await GET(
      createMockRequest('/api/company/company-1/migration-reset/archive'),
      params,
    )

    expect(response.status).toBe(401)
    expect(mockEstimate).not.toHaveBeenCalled()
  })

  it('returns 404 when the URL is not the active replacement company', async () => {
    const response = await GET(
      createMockRequest('/api/company/company-2/migration-reset/archive'),
      { params: Promise.resolve({ id: 'company-2' }) },
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockEstimate).not.toHaveBeenCalled()
  })

  it('returns 403 to a non-owner replacement member', async () => {
    enqueue({ data: { role: 'admin' }, error: null })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await GET(createMockRequest('/api/company/company-1/migration-reset/archive'), params),
    )

    expect(status).toBe(403)
    expect(body.error.code).toBe('COMPANY_RESET_FORBIDDEN')
    expect(mockEstimate).not.toHaveBeenCalled()
  })

  it('returns 404 when the active company has no retained reset source', async () => {
    enqueue({ data: { role: 'owner' }, error: null })
    enqueue({ data: null, error: null })

    const response = await GET(
      createMockRequest('/api/company/company-1/migration-reset/archive'),
      params,
    )

    expect(response.status).toBe(404)
    expect(mockEstimate).not.toHaveBeenCalled()
  })

  it('returns retained-source metadata and size for an owner', async () => {
    enqueueAuthorizedArchive()

    const response = await GET(
      createMockRequest('/api/company/company-1/migration-reset/archive', {
        searchParams: { estimate: '1' },
      }),
      params,
    )
    const { status, body } = await parseJsonResponse<{
      data: { archived_at: string; document_count: number; within_limit: boolean }
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toMatchObject({
      archived_at: '2026-08-18T14:00:00.000Z',
      document_count: 2,
      within_limit: true,
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockEstimate).toHaveBeenCalledWith(archiveSupabase, 'source-1', 'all')
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('downloads the retained source without changing the active company', async () => {
    enqueueAuthorizedArchive()
    mockGenerate.mockResolvedValue(new ArrayBuffer(1024))

    const response = await GET(
      createMockRequest('/api/company/company-1/migration-reset/archive'),
      params,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/zip')
    expect(response.headers.get('Content-Disposition')).toMatch(
      /^attachment; filename="migration_reset_archive_\d{8}\.zip"$/,
    )
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockGenerate).toHaveBeenCalledWith(archiveSupabase, 'source-1', {
      include_documents: true,
    })
  })

  it('requires an explicit document-free download when the ZIP is over limit', async () => {
    enqueueAuthorizedArchive()
    mockEstimate.mockResolvedValue({
      total_bytes: 100 * 1024 * 1024,
      document_bytes: 92 * 1024 * 1024,
      document_count: 10,
    })

    const response = await GET(
      createMockRequest('/api/company/company-1/migration-reset/archive'),
      params,
    )

    expect(response.status).toBe(413)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('downloads without documents when the planned payload is within the limit', async () => {
    enqueueAuthorizedArchive()
    mockEstimate.mockResolvedValue({
      total_bytes: 100 * 1024 * 1024,
      document_bytes: 92 * 1024 * 1024,
      document_count: 10,
    })
    mockGenerate.mockResolvedValue(new ArrayBuffer(1024))

    const response = await GET(
      createMockRequest('/api/company/company-1/migration-reset/archive', {
        searchParams: { include_documents: 'false' },
      }),
      params,
    )

    expect(response.status).toBe(200)
    expect(mockGenerate).toHaveBeenCalledWith(archiveSupabase, 'source-1', {
      include_documents: false,
    })
  })

  it('blocks a document-free download when its planned payload is still over the limit', async () => {
    enqueueAuthorizedArchive()
    mockEstimate.mockResolvedValue({
      total_bytes: 100 * 1024 * 1024,
      document_bytes: 10 * 1024 * 1024,
      document_count: 10,
    })

    const response = await GET(
      createMockRequest('/api/company/company-1/migration-reset/archive', {
        searchParams: { include_documents: 'false' },
      }),
      params,
    )
    const { status, body } = await parseJsonResponse<{
      size_bytes: number
      size_limit_bytes: number
    }>(response)

    expect(status).toBe(413)
    expect(body.size_bytes).toBe(90 * 1024 * 1024)
    expect(body.size_limit_bytes).toBe(80 * 1024 * 1024)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('keeps the archive reachable when retained-source membership changes', async () => {
    enqueueAuthorizedArchive()

    const response = await GET(
      createMockRequest('/api/company/company-1/migration-reset/archive', {
        searchParams: { estimate: '1' },
      }),
      params,
    )

    expect(response.status).toBe(200)
    expect(mockEstimate).toHaveBeenCalledWith(archiveSupabase, 'source-1', 'all')
    expect(archiveCalls).not.toContainEqual({
      table: 'company_members',
      method: 'eq',
      args: ['company_id', 'source-1'],
    })
  })

  it('fails closed when the retained source is not archived', async () => {
    enqueue({ data: { role: 'owner' }, error: null })
    enqueue({
      data: { source_company_id: 'source-1', created_at: '2026-08-18T14:00:00.000Z' },
      error: null,
    })
    enqueueArchive({
      data: { source_company_id: 'source-1', created_at: '2026-08-18T14:00:00.000Z' },
      error: null,
    })
    enqueueArchive({ data: { role: 'owner' }, error: null })
    enqueueArchive({ data: { archived_at: null }, error: null })

    const response = await GET(
      createMockRequest('/api/company/company-1/migration-reset/archive'),
      params,
    )

    expect(response.status).toBe(403)
    expect(mockEstimate).not.toHaveBeenCalled()
  })

  it('returns 500 when archive generation fails', async () => {
    enqueueAuthorizedArchive()
    mockGenerate.mockRejectedValue(new Error('storage unavailable'))

    const response = await GET(
      createMockRequest('/api/company/company-1/migration-reset/archive'),
      params,
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(500)
    expect(body.error.code).toBe('COMPANY_RESET_FAILED')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
})
