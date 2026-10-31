import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { mockLogInfo, mockLogWarn, mockLogError } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
    child: vi.fn().mockReturnThis(),
  }),
}))

const { supabase, enqueue, reset } = createQueuedMockSupabase()
const {
  supabase: archiveSupabase,
  enqueue: enqueueArchive,
  reset: resetArchive,
} = createQueuedMockSupabase()
const createServiceClientMock = vi.fn(() => archiveSupabase)

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

// generateFullArchive is mocked too, so the case below that pins #142 runs
// unchanged against the route before streaming (where it answered 413).
vi.mock('@/lib/reports/full-archive-export', () => ({
  generateFullArchive: vi.fn(),
  streamFullArchive: vi.fn(),
  estimateArchiveSize: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => createServiceClientMock(),
}))

import {
  generateFullArchive,
  streamFullArchive,
  estimateArchiveSize,
} from '@/lib/reports/full-archive-export'
import { GET as routeGET } from '../route'

const GET = (request: Request) => routeGET(request, { params: Promise.resolve({}) })
const mockGenerate = vi.mocked(generateFullArchive)
const mockStream = vi.mocked(streamFullArchive)
const mockEstimate = vi.mocked(estimateArchiveSize)

const GIB = 1024 * 1024 * 1024

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield new TextEncoder().encode(part)
}

function authed() {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

function unauthed() {
  requireAuthMock.mockResolvedValue({
    user: null,
    supabase,
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  resetArchive()
  authed()
  enqueue({ data: { role: 'admin' }, error: null })
  enqueueArchive({ data: { role: 'admin' }, error: null })
})

describe('GET /api/reports/full-archive', () => {
  it('returns 401 when not authenticated', async () => {
    unauthed()
    const { status, body } = await parseJsonResponse(
      await GET(createMockRequest('/api/reports/full-archive'))
    )
    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 403 for a member without archive-audit access', async () => {
    reset()
    enqueue({ data: { role: 'member' }, error: null })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await GET(createMockRequest('/api/reports/full-archive')),
    )

    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(mockLogWarn).toHaveBeenCalledWith('full archive access denied', {
      userId: 'user-1',
      companyId: 'company-1',
      role: 'member',
    })
    expect(createServiceClientMock).not.toHaveBeenCalled()
    expect(mockEstimate).not.toHaveBeenCalled()
    expect(mockStream).not.toHaveBeenCalled()
  })

  it('rejects when the verified user is not a member of the selected company', async () => {
    reset()
    resetArchive()
    enqueue({ data: { role: 'admin' }, error: null })
    enqueueArchive({ data: null, error: null })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await GET(createMockRequest('/api/reports/full-archive')),
    )

    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(mockEstimate).not.toHaveBeenCalled()
    expect(mockStream).not.toHaveBeenCalled()
  })

  it('returns 500 when the service-role membership verification fails', async () => {
    reset()
    resetArchive()
    enqueue({ data: { role: 'admin' }, error: null })
    enqueueArchive({ data: null, error: new Error('database unavailable') })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await GET(createMockRequest('/api/reports/full-archive')),
    )

    expect(status).toBe(500)
    expect(body.error.code).toBe('INTERNAL_ERROR')
    expect(mockEstimate).not.toHaveBeenCalled()
    expect(mockStream).not.toHaveBeenCalled()
  })

  it('returns the size estimate alone when ?estimate=1', async () => {
    mockEstimate.mockResolvedValue({
      total_bytes: 10_000_000,
      document_bytes: 5_000_000,
      document_count: 7,
    })

    const response = await GET(
      createMockRequest('/api/reports/full-archive', {
        searchParams: { estimate: '1', scope: 'all' },
      }),
    )
    const { status, body } = await parseJsonResponse<{ data: Record<string, number> }>(response)

    expect(status).toBe(200)
    // No size limit to report: the download streams.
    expect(body.data).toEqual({ total_bytes: 10_000_000, document_bytes: 5_000_000, document_count: 7 })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockEstimate).toHaveBeenCalledWith(archiveSupabase, 'company-1', 'all', undefined)
    expect(mockStream).not.toHaveBeenCalled()
  })

  it('answers a failed estimate with the error envelope', async () => {
    mockEstimate.mockRejectedValue(new Error('database unavailable'))

    const response = await GET(
      createMockRequest('/api/reports/full-archive', { searchParams: { estimate: '1' } }),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(500)
    expect(body.error.code).toBe('INTERNAL_ERROR')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  // #142: five years of underlag is gigabytes, and the 80 MB cap answered 413
  // to the one export meant to hold everything.
  it('streams the archive of a company with gigabytes of underlag instead of refusing it', async () => {
    mockEstimate.mockResolvedValue({
      total_bytes: 4 * GIB,
      document_bytes: 4 * GIB - 8 * 1024 * 1024,
      document_count: 4400,
    })
    mockStream.mockReturnValue(chunks('PK', '-zip-', 'bytes'))
    mockGenerate.mockResolvedValue(new TextEncoder().encode('PK-zip-bytes').buffer)

    const response = await GET(
      createMockRequest('/api/reports/full-archive', { searchParams: { scope: 'all' } }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/zip')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Content-Disposition')).toMatch(/arkiv_full_company-1_\d{8}\.zip/)
    expect(await response.text()).toBe('PK-zip-bytes')
    expect(mockStream).toHaveBeenCalledWith(
      archiveSupabase,
      'company-1',
      { scope: 'all', include_documents: true },
    )
    // The download needs no estimate: nothing is refused on size.
    expect(mockEstimate).not.toHaveBeenCalled()
    expect(mockLogInfo).toHaveBeenCalledWith('full archive generated', expect.objectContaining({
      filename: expect.stringMatching(/^arkiv_full_company-1_\d{8}\.zip$/),
      sizeBytes: 12,
    }))
  })

  it('passes include_documents=false through', async () => {
    mockStream.mockReturnValue(chunks('PK'))

    const response = await GET(
      createMockRequest('/api/reports/full-archive', {
        searchParams: { scope: 'all', include_documents: 'false' },
      })
    )

    expect(response.status).toBe(200)
    await response.arrayBuffer()
    expect(mockStream).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      expect.objectContaining({ scope: 'all', include_documents: false })
    )
  })

  it('defaults to scope=all when no params given', async () => {
    mockStream.mockReturnValue(chunks('PK'))

    const response = await GET(createMockRequest('/api/reports/full-archive'))

    expect(response.status).toBe(200)
    expect(mockStream).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      expect.objectContaining({ scope: 'all' })
    )
  })

  it('uses scope=period when period_id is provided without explicit scope', async () => {
    mockStream.mockReturnValue(chunks('PK'))

    const response = await GET(
      createMockRequest('/api/reports/full-archive', {
        searchParams: { period_id: 'period-1' },
      })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Disposition')).toContain('arkiv_period-1.zip')
    expect(mockStream).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      expect.objectContaining({ scope: 'period', period_id: 'period-1' })
    )
  })

  it('returns 400 when scope=period without period_id', async () => {
    const response = await GET(
      createMockRequest('/api/reports/full-archive', {
        searchParams: { scope: 'period' },
      }),
    )
    const { status, body } = await parseJsonResponse(response)
    expect(status).toBe(400)
    expect(body).toEqual({ error: 'period_id is required when scope=period' })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockStream).not.toHaveBeenCalled()
    expect(mockEstimate).not.toHaveBeenCalled()
  })

  it('cuts the download off and logs it when the archive fails part way', async () => {
    mockStream.mockReturnValue((async function* () {
      yield new TextEncoder().encode('PK')
      throw new Error('Fiscal period not found')
    })())

    const response = await GET(
      createMockRequest('/api/reports/full-archive', {
        searchParams: { scope: 'period', period_id: 'nope' },
      }),
    )

    // The headers went out first; the failure can only end the body early,
    // which the browser reports as a failed download.
    expect(response.status).toBe(200)
    await expect(response.arrayBuffer()).rejects.toThrow('Fiscal period not found')
    expect(mockLogError).toHaveBeenCalledWith(
      'full archive generation failed',
      expect.objectContaining({ message: 'Fiscal period not found' }),
      expect.objectContaining({ companyId: 'company-1', scope: 'period', bytesSent: 2 }),
    )
    expect(mockLogInfo).not.toHaveBeenCalledWith('full archive generated', expect.anything())
  })

  it('stops reading the archive when the client goes away', async () => {
    let closed = false
    let reads = 0
    mockStream.mockReturnValue((async function* () {
      try {
        for (;;) {
          reads++
          yield new Uint8Array(1024)
        }
      } finally {
        closed = true
      }
    })())

    const response = await GET(createMockRequest('/api/reports/full-archive'))
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()

    expect(closed).toBe(true)
    // Read only as far as the client took it, one chunk ahead at most.
    expect(reads).toBeLessThanOrEqual(3)
    expect(mockLogInfo).toHaveBeenCalledWith('full archive download cancelled', expect.objectContaining({
      companyId: 'company-1',
    }))
  })
})
