/**
 * Tests for GET /api/bookkeeping/journal-entries/[id]/retag-log
 * (dimensions plan PR6 — the immutable retag history).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createQueuedMockSupabase,
  createMockRequest,
  createMockRouteParams,
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

const params = () => createMockRouteParams({ id: 'entry-1' })
const makeGet = () =>
  createMockRequest('/api/bookkeeping/journal-entries/entry-1/retag-log', { method: 'GET' })

describe('GET /api/bookkeeping/journal-entries/[id]/retag-log', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await GET(makeGet(), params())
    expect(response.status).toBe(401)
  })

  it('returns the log rows newest first', async () => {
    enqueue({
      data: [
        {
          id: 'log-2',
          line_id: 'line-1',
          old_dimensions: { '6': 'P001' },
          new_dimensions: { '6': 'P002' },
          actor: 'user-1',
          reason: 'Bytt projekt',
          created_at: '2026-07-02T12:00:00Z',
        },
      ],
      error: null,
    })

    const response = await GET(makeGet(), params())
    const { body } = await parseJsonResponse<{ data: { id: string }[] }>(response)

    expect(response.status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].id).toBe('log-2')
  })

  it('returns 500 with a Swedish message when the query fails', async () => {
    enqueue({ data: null, error: { message: 'boom' } })

    const response = await GET(makeGet(), params())
    const { body } = await parseJsonResponse<{ error: string }>(response)

    expect(response.status).toBe(500)
    expect(body.error).toContain('historik')
  })
})
