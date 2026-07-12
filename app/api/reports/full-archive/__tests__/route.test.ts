/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/reports/full-archive-export', () => ({
  generateFullArchive: vi.fn(),
  estimateArchiveSize: vi.fn(),
}))

import {
  generateFullArchive,
  estimateArchiveSize,
} from '@/lib/reports/full-archive-export'
import { GET } from '../route'

const mockGenerate = vi.mocked(generateFullArchive)
const mockEstimate = vi.mocked(estimateArchiveSize)

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
  authed()
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

  it('returns estimate-only response when ?estimate=1', async () => {
    mockEstimate.mockResolvedValue({
      total_bytes: 10_000_000,
      document_bytes: 5_000_000,
      document_count: 7,
    })

    const { status, body } = await parseJsonResponse<{
      data: {
        total_bytes: number
        size_limit_bytes: number
        within_limit: boolean
      }
    }>(
      await GET(
        createMockRequest('/api/reports/full-archive', {
          searchParams: { estimate: '1', scope: 'all' },
        })
      )
    )

    expect(status).toBe(200)
    expect(body.data.total_bytes).toBe(10_000_000)
    expect(body.data.within_limit).toBe(true)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('returns 413 archive_too_large when estimate exceeds limit', async () => {
    mockEstimate.mockResolvedValue({
      total_bytes: 200 * 1024 * 1024,
      document_bytes: 195 * 1024 * 1024,
      document_count: 200,
    })

    const response = await GET(
      createMockRequest('/api/reports/full-archive', {
        searchParams: { scope: 'all' },
      })
    )
    const { status, body } = await parseJsonResponse<{
      error: string
      size_bytes: number
      size_limit_bytes: number
    }>(response)

    expect(status).toBe(413)
    expect(body.error).toBe('archive_too_large')
    expect(body.size_bytes).toBe(200 * 1024 * 1024)
    expect(body.size_limit_bytes).toBe(80 * 1024 * 1024)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('skips 413 when include_documents=false', async () => {
    mockEstimate.mockResolvedValue({
      total_bytes: 200 * 1024 * 1024,
      document_bytes: 195 * 1024 * 1024,
      document_count: 200,
    })
    mockGenerate.mockResolvedValue(new ArrayBuffer(1024))

    const response = await GET(
      createMockRequest('/api/reports/full-archive', {
        searchParams: { scope: 'all', include_documents: 'false' },
      })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/zip')
    expect(mockGenerate).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      expect.objectContaining({ scope: 'all', include_documents: false })
    )
  })

  it('defaults to scope=all when no params given', async () => {
    mockEstimate.mockResolvedValue({
      total_bytes: 1_000_000,
      document_bytes: 500_000,
      document_count: 2,
    })
    mockGenerate.mockResolvedValue(new ArrayBuffer(1024))

    const response = await GET(createMockRequest('/api/reports/full-archive'))

    expect(response.status).toBe(200)
    expect(mockGenerate).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      expect.objectContaining({ scope: 'all' })
    )
  })

  it('uses scope=period when period_id is provided without explicit scope', async () => {
    mockEstimate.mockResolvedValue({
      total_bytes: 1_000_000,
      document_bytes: 500_000,
      document_count: 2,
    })
    mockGenerate.mockResolvedValue(new ArrayBuffer(1024))

    const response = await GET(
      createMockRequest('/api/reports/full-archive', {
        searchParams: { period_id: 'period-1' },
      })
    )

    expect(response.status).toBe(200)
    expect(mockGenerate).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      expect.objectContaining({ scope: 'period', period_id: 'period-1' })
    )
  })

  it('returns 400 when scope=period without period_id', async () => {
    const { status, body } = await parseJsonResponse(
      await GET(
        createMockRequest('/api/reports/full-archive', {
          searchParams: { scope: 'period' },
        })
      )
    )
    expect(status).toBe(400)
    expect(body).toEqual({ error: 'period_id is required when scope=period' })
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(mockEstimate).not.toHaveBeenCalled()
  })

  it('returns 404 when generate throws "not found"', async () => {
    mockEstimate.mockResolvedValue({
      total_bytes: 1_000_000,
      document_bytes: 500_000,
      document_count: 2,
    })
    mockGenerate.mockRejectedValue(new Error('Fiscal period not found'))

    const { status, body } = await parseJsonResponse(
      await GET(
        createMockRequest('/api/reports/full-archive', {
          searchParams: { scope: 'period', period_id: 'nope' },
        })
      )
    )
    expect(status).toBe(404)
    expect(body).toEqual({ error: 'Fiscal period not found' })
  })
})
