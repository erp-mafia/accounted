/**
 * Tests for GET /api/bookkeeping/journal-entries/rattelse-flags
 * (which entries carry inline rättelser, for the list "Rättad" marker).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { GET } from '../route'

const makeGet = (ids: string) =>
  createMockRequest(`/api/bookkeeping/journal-entries/rattelse-flags?ids=${ids}`, { method: 'GET' })

describe('GET /api/bookkeeping/journal-entries/rattelse-flags', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await GET(makeGet('a'), undefined as never)
    expect(response.status).toBe(401)
  })

  it('returns an empty list without querying when no ids are given', async () => {
    const response = await GET(makeGet(''), undefined as never)
    const { body } = await parseJsonResponse<{ data: string[] }>(response)
    expect(response.status).toBe(200)
    expect(body.data).toEqual([])
  })

  it('rejects more than 200 ids with 400', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `id-${i}`).join(',')
    const response = await GET(makeGet(ids), undefined as never)
    expect(response.status).toBe(400)
  })

  it('returns the distinct entry ids that have rättelser', async () => {
    enqueue({
      data: [
        { journal_entry_id: 'entry-1' },
        { journal_entry_id: 'entry-1' },
        { journal_entry_id: 'entry-3' },
      ],
      error: null,
    })

    const response = await GET(makeGet('entry-1,entry-2,entry-3'), undefined as never)
    const { body } = await parseJsonResponse<{ data: string[] }>(response)

    expect(response.status).toBe(200)
    expect(body.data.sort()).toEqual(['entry-1', 'entry-3'])
  })

  it('returns 500 with a Swedish message when the query fails', async () => {
    enqueue({ data: null, error: { message: 'boom' } })

    const response = await GET(makeGet('entry-1'), undefined as never)
    expect(response.status).toBe(500)
  })
})
