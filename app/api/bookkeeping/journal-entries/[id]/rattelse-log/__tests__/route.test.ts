/**
 * Tests for GET /api/bookkeeping/journal-entries/[id]/rattelse-log
 * (the immutable inline rättelse history, BFL 5 kap 5 § / 9 §).
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
  createMockRequest('/api/bookkeeping/journal-entries/entry-1/rattelse-log', { method: 'GET' })

describe('GET /api/bookkeeping/journal-entries/[id]/rattelse-log', () => {
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

  it('returns 404 when the entry belongs to another company', async () => {
    enqueue({ data: null, error: null }) // ownership check finds nothing

    const response = await GET(makeGet(), params())
    const { body } = await parseJsonResponse<{ error: string }>(response)

    expect(response.status).toBe(404)
    expect(body.error).toContain('hittades inte')
  })

  it('returns the rättelse rows newest first', async () => {
    enqueue({ data: { id: 'entry-1' }, error: null }) // ownership check
    enqueue({
      data: [
        {
          id: 'log-2',
          rattelse_type: 'lines',
          old_description: null,
          new_description: null,
          old_entry_date: null,
          new_entry_date: null,
          struck_lines: [
            { id: 'line-1', account_number: '5410', debit_amount: 500, credit_amount: 0, line_description: null, sort_order: 1 },
          ],
          added_lines: [
            { id: 'line-9', account_number: '5420', debit_amount: 500, credit_amount: 0, line_description: null, sort_order: 3 },
          ],
          actor: 'user-1',
          created_at: '2026-07-23T12:00:00Z',
        },
        {
          id: 'log-1',
          rattelse_type: 'metadata',
          old_description: 'Gamal text',
          new_description: 'Rättad text',
          old_entry_date: '2026-07-01',
          new_entry_date: '2026-07-01',
          struck_lines: null,
          added_lines: null,
          actor: 'user-1',
          created_at: '2026-07-22T12:00:00Z',
        },
      ],
      error: null,
    })

    const response = await GET(makeGet(), params())
    const { body } = await parseJsonResponse<{ data: { id: string; rattelse_type: string }[] }>(response)

    expect(response.status).toBe(200)
    expect(body.data).toHaveLength(2)
    expect(body.data[0].id).toBe('log-2')
    expect(body.data[0].rattelse_type).toBe('lines')
  })

  it('returns 500 with a Swedish message when the query fails', async () => {
    enqueue({ data: { id: 'entry-1' }, error: null }) // ownership check
    enqueue({ data: null, error: { message: 'boom' } })

    const response = await GET(makeGet(), params())
    const { body } = await parseJsonResponse<{ error: string }>(response)

    expect(response.status).toBe(500)
    expect(body.error).toContain('historik')
  })
})
