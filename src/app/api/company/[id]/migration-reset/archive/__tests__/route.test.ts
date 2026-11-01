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
  streamFullArchive: vi.fn(),
}))

import {
  estimateArchiveSize,
  streamFullArchive,
} from '@/lib/reports/full-archive-export'
import { GET } from '../route'

const mockEstimate = vi.mocked(estimateArchiveSize)
const mockStream = vi.mocked(streamFullArchive)
const params = { params: Promise.resolve({ id: 'company-1' }) }

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield new TextEncoder().encode(part)
}

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
      data: Record<string, unknown>
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toEqual({
      archived_at: '2026-08-18T14:00:00.000Z',
      total_bytes: 10_000_000,
      document_bytes: 1_000_000,
      document_count: 2,
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockEstimate).toHaveBeenCalledWith(archiveSupabase, 'source-1', 'all')
    expect(mockStream).not.toHaveBeenCalled()
  })

  it("stamps the file with the Swedish day, also on New Year's night", async () => {
    enqueueAuthorizedArchive()
    mockStream.mockReturnValue(chunks('PK'))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-12-31T23:30:00Z'))
    try {
      const response = await GET(createMockRequest('/api/company/company-1/migration-reset/archive'), params)
      expect(response.headers.get('Content-Disposition')).toContain('migration_reset_archive_20270101.zip')
    } finally {
      vi.useRealTimers()
    }
  })

  it('downloads the retained source without changing the active company', async () => {
    enqueueAuthorizedArchive()
    mockStream.mockReturnValue(chunks('PK', '-zip'))

    const response = await GET(
      createMockRequest('/api/company/company-1/migration-reset/archive'),
      params,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/zip')
    expect(response.headers.get('Content-Disposition')).toMatch(
      /^attachment; filename="migration_reset_archive_\d{8}\.zip"; filename\*=UTF-8''migration_reset_archive_\d{8}\.zip$/,
    )
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.text()).toBe('PK-zip')
    expect(mockStream).toHaveBeenCalledWith(archiveSupabase, 'source-1', {
      scope: 'all',
      include_documents: true,
    })
  })

  // #142: the retained archive refused anything over 80 MB with documents.
  it('streams a retained source of several gigabytes with its documents', async () => {
    enqueueAuthorizedArchive()
    mockEstimate.mockResolvedValue({
      total_bytes: 3 * 1024 * 1024 * 1024,
      document_bytes: 3 * 1024 * 1024 * 1024 - 8 * 1024 * 1024,
      document_count: 3000,
    })
    mockStream.mockReturnValue(chunks('PK'))

    const response = await GET(
      createMockRequest('/api/company/company-1/migration-reset/archive'),
      params,
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('PK')
    expect(mockEstimate).not.toHaveBeenCalled()
  })

  it('downloads without documents when asked to', async () => {
    enqueueAuthorizedArchive()
    mockStream.mockReturnValue(chunks('PK'))

    const response = await GET(
      createMockRequest('/api/company/company-1/migration-reset/archive', {
        searchParams: { include_documents: 'false' },
      }),
      params,
    )

    expect(response.status).toBe(200)
    expect(mockStream).toHaveBeenCalledWith(archiveSupabase, 'source-1', {
      scope: 'all',
      include_documents: false,
    })
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

  it('answers a failed estimate with the reset error envelope', async () => {
    enqueueAuthorizedArchive()
    mockEstimate.mockRejectedValue(new Error('storage unavailable'))

    const response = await GET(
      createMockRequest('/api/company/company-1/migration-reset/archive', {
        searchParams: { estimate: '1' },
      }),
      params,
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(500)
    expect(body.error.code).toBe('COMPANY_RESET_FAILED')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('cuts the download off when the archive fails part way', async () => {
    enqueueAuthorizedArchive()
    mockStream.mockReturnValue((async function* () {
      yield new TextEncoder().encode('PK')
      throw new Error('storage unavailable')
    })())

    const response = await GET(
      createMockRequest('/api/company/company-1/migration-reset/archive'),
      params,
    )

    expect(response.status).toBe(200)
    await expect(response.arrayBuffer()).rejects.toThrow('storage unavailable')
  })
})
