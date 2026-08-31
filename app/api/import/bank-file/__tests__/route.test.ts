/**
 * Tests for GET /api/import/bank-file (the bank file import list).
 *
 * Exercises the route through the real withRouteContext wrapper, mocking only
 * its auth/company dependencies and injecting a queued Supabase mock via
 * requireAuth. Covers: 401, the { data, count, limit, offset } happy-path
 * shape, the status filter, and the 500 path returning a Swedish error.
 * Mirrors the GET /api/import/sie list test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'

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
  filename: 'kontoutdrag-2026.csv',
  file_format: 'swedbank',
  transaction_count: 212,
  imported_count: 208,
  duplicate_count: 4,
  matched_count: 12,
  status: 'completed',
  created_at: '2026-08-01T08:59:00Z',
  updated_at: '2026-08-01T09:00:00Z',
  ...overrides,
})

describe('GET /api/import/bank-file', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await GET(createMockRequest('/api/import/bank-file'), staticParams())

    expect(response.status).toBe(401)
  })

  it('returns { data, count, limit, offset } with defaults', async () => {
    const rows = [makeImportRow(), makeImportRow({ id: 'import-2', status: 'undone' })]
    enqueue({ data: rows, count: 2 })

    const response = await GET(createMockRequest('/api/import/bank-file'), staticParams())
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
    expect(findCalls('bank_file_imports', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(findCalls('bank_file_imports', 'order')).toContainEqual([
      'created_at',
      { ascending: false },
    ])
    expect(findCalls('bank_file_imports', 'range')).toContainEqual([0, 19])
  })

  it('applies the status filter and custom limit/offset', async () => {
    enqueue({ data: [makeImportRow()], count: 1 })

    const response = await GET(
      createMockRequest('/api/import/bank-file', {
        searchParams: { status: 'completed', limit: '5', offset: '10' },
      }),
      staticParams(),
    )
    const { status, body } = await parseJsonResponse<{ limit: number; offset: number }>(response)

    expect(status).toBe(200)
    expect(body.limit).toBe(5)
    expect(body.offset).toBe(10)
    expect(findCalls('bank_file_imports', 'eq')).toContainEqual(['status', 'completed'])
    expect(findCalls('bank_file_imports', 'range')).toContainEqual([10, 14])
  })

  it.each([
    { name: 'non-numeric limit', searchParams: { limit: 'abc' } },
    { name: 'partial-integer limit', searchParams: { limit: '12abc' } },
    { name: 'negative limit', searchParams: { limit: '-1' } },
    { name: 'zero limit', searchParams: { limit: '0' } },
    { name: 'limit above the cap', searchParams: { limit: '101' } },
    { name: 'negative offset', searchParams: { offset: '-5' } },
    { name: 'non-numeric offset', searchParams: { offset: 'NaN' } },
    { name: 'unknown status', searchParams: { status: 'sabotage' } },
  ])('returns a mapped 400 for $name', async ({ searchParams }) => {
    const response = await GET(
      createMockRequest('/api/import/bank-file', { searchParams }),
      staticParams(),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('BANK_FILE_LIST_INVALID_QUERY')
    // Invalid input must never reach the query builder.
    expect(findCalls('bank_file_imports', 'range')).toEqual([])
  })

  it('accepts the boundary values limit=1, limit=100 and offset=0', async () => {
    enqueue({ data: [], count: 0 })
    enqueue({ data: [], count: 0 })

    const min = await GET(
      createMockRequest('/api/import/bank-file', { searchParams: { limit: '1', offset: '0' } }),
      staticParams(),
    )
    expect(min.status).toBe(200)

    const max = await GET(
      createMockRequest('/api/import/bank-file', { searchParams: { limit: '100' } }),
      staticParams(),
    )
    expect(max.status).toBe(200)
    expect(findCalls('bank_file_imports', 'range')).toContainEqual([0, 0])
    expect(findCalls('bank_file_imports', 'range')).toContainEqual([0, 99])
  })

  it('returns 500 with a Swedish error message on a database error', async () => {
    enqueue({ data: null, error: { message: 'connection reset by peer' } })

    const response = await GET(createMockRequest('/api/import/bank-file'), staticParams())
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect(typeof body.error).toBe('string')
    // The raw driver message must not leak; the mapped message is Swedish.
    expect(body.error).not.toContain('connection reset')
    expect(body.error).toBe('Något gick fel. Försök igen.')
  })
})
