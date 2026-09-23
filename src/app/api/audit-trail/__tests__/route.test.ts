/**
 * Tests for GET /api/audit-trail.
 *
 * Exercises the route through the real withRouteContext wrapper, mocking its
 * auth/company dependencies and the audit service. Covers: auth 401, query
 * validation 400, filter passthrough, and the canonical 500 envelope.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/core/audit/audit-service', () => ({
  getAuditLog: vi.fn(),
}))

import { getAuditLog } from '@/lib/core/audit/audit-service'
import { GET } from '../route'

const mockGetAuditLog = vi.mocked(getAuditLog)
const routeParams = { params: Promise.resolve({}) }

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: {}, error: null })
})

describe('GET /api/audit-trail', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const req = createMockRequest('/api/audit-trail')
    const { status, body } = await parseJsonResponse(await GET(req, routeParams))

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 400 for an unknown action filter', async () => {
    const req = createMockRequest('/api/audit-trail', {
      searchParams: { action: 'NOT_AN_ACTION' },
    })
    const { status } = await parseJsonResponse(await GET(req, routeParams))

    expect(status).toBe(400)
    expect(mockGetAuditLog).not.toHaveBeenCalled()
  })

  it('returns 400 for a non-numeric page', async () => {
    const req = createMockRequest('/api/audit-trail', {
      searchParams: { page: 'abc' },
    })
    const { status } = await parseJsonResponse(await GET(req, routeParams))

    expect(status).toBe(400)
    expect(mockGetAuditLog).not.toHaveBeenCalled()
  })

  it('returns audit log with data and count, defaulting pagination', async () => {
    const entries = [
      { id: '1', action: 'INSERT', table_name: 'journal_entries', created_at: '2024-01-01T00:00:00Z' },
      { id: '2', action: 'COMMIT', table_name: 'journal_entries', created_at: '2024-01-02T00:00:00Z' },
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetAuditLog.mockResolvedValue({ data: entries as any, count: 2 })

    const req = createMockRequest('/api/audit-trail')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { status, body } = await parseJsonResponse<{ data: any[]; count: number }>(
      await GET(req, routeParams)
    )

    expect(status).toBe(200)
    expect(body.data).toHaveLength(2)
    expect(body.count).toBe(2)
    expect(mockGetAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      expect.objectContaining({ page: 1, pageSize: 50 })
    )
  })

  it('passes query param filters to getAuditLog', async () => {
    mockGetAuditLog.mockResolvedValue({ data: [], count: 0 })

    const req = createMockRequest('/api/audit-trail', {
      searchParams: {
        action: 'INSERT',
        table_name: 'journal_entries',
        record_id: 'rec-1',
        from_date: '2024-01-01',
        to_date: '2024-12-31',
        page: '2',
        page_size: '25',
      },
    })

    await GET(req, routeParams)

    expect(mockGetAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      {
        action: 'INSERT',
        table_name: 'journal_entries',
        record_id: 'rec-1',
        from_date: '2024-01-01',
        to_date: '2024-12-31',
        page: 2,
        pageSize: 25,
      }
    )
  })

  it('returns the canonical error envelope on service failure', async () => {
    mockGetAuditLog.mockRejectedValue(new Error('DB error'))

    const req = createMockRequest('/api/audit-trail')
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await GET(req, routeParams)
    )

    expect(status).toBe(500)
    expect(body.error.code).toBe('INTERNAL_ERROR')
  })
})
