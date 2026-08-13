/**
 * Tests for GET /api/import/sie (the SIE import list).
 *
 * Exercises the route through the real withRouteContext wrapper, mocking only
 * its auth/company dependencies and injecting a queued Supabase mock via
 * requireAuth. Covers: 401, the { data, count, limit, offset } happy-path
 * shape, the status filter, and the 500 path returning a Swedish error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

// Next.js 16 always passes a params promise, even on static routes.
const staticParams = () => createMockRouteParams({})

const makeImportRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'import-1',
  company_id: 'company-1',
  filename: 'bokforing-2025.se',
  fiscal_year_start: '2025-01-01',
  fiscal_year_end: '2025-12-31',
  transactions_count: 214,
  status: 'completed',
  imported_at: '2026-08-01T09:00:00Z',
  created_at: '2026-08-01T08:59:00Z',
  ...overrides,
})

describe('GET /api/import/sie', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(createMockRequest('/api/import/sie'), staticParams())

    expect(response.status).toBe(401)
  })

  it('returns { data, count, limit, offset } with defaults', async () => {
    const rows = [makeImportRow(), makeImportRow({ id: 'import-2', status: 'undone' })]
    enqueue({ data: rows, count: 2 })

    const response = await GET(createMockRequest('/api/import/sie'), staticParams())
    const { status, body } = await parseJsonResponse<{
      data: { id: string }[]
      count: number
      limit: number
      offset: number
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toHaveLength(2)
    expect(body.data[0].id).toBe('import-1')
    expect(body.count).toBe(2)
    expect(body.limit).toBe(20)
    expect(body.offset).toBe(0)

    // Scoped to the active company; ordered newest-first; default range 0-19.
    expect(findCalls('sie_imports', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(findCalls('sie_imports', 'order')).toContainEqual(['created_at', { ascending: false }])
    expect(findCalls('sie_imports', 'range')).toContainEqual([0, 19])
  })

  it('applies the status filter and custom limit/offset', async () => {
    enqueue({ data: [makeImportRow()], count: 1 })

    const response = await GET(
      createMockRequest('/api/import/sie', {
        searchParams: { status: 'completed', limit: '5', offset: '10' },
      }),
      staticParams(),
    )
    const { status, body } = await parseJsonResponse<{ limit: number; offset: number }>(response)

    expect(status).toBe(200)
    expect(body.limit).toBe(5)
    expect(body.offset).toBe(10)
    expect(findCalls('sie_imports', 'eq')).toContainEqual(['status', 'completed'])
    expect(findCalls('sie_imports', 'range')).toContainEqual([10, 14])
  })

  it('returns 500 with a Swedish error message on a database error', async () => {
    enqueue({ data: null, error: { message: 'connection reset by peer' } })

    const response = await GET(createMockRequest('/api/import/sie'), staticParams())
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect(typeof body.error).toBe('string')
    // The raw driver message must not leak; the mapped message is Swedish.
    expect(body.error).not.toContain('connection reset')
    expect(body.error).toBe('Något gick fel. Försök igen.')
  })
})
