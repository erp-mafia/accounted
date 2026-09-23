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
// Service-role client for the profiles lookup (profiles RLS is self-only).
const service = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const createServiceClientMock = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: (...args: unknown[]) => createServiceClientMock(...args),
}))

import { GET } from '../route'

const params = () => createMockRouteParams({ id: 'entry-1' })
const makeGet = () =>
  createMockRequest('/api/bookkeeping/journal-entries/entry-1/rattelse-log', { method: 'GET' })

const linesRow = (id: string, actor: string | null, created_at: string) => ({
  id,
  rattelse_type: 'lines',
  old_description: null,
  new_description: null,
  old_entry_date: null,
  new_entry_date: null,
  struck_lines: [
    { id: `${id}-struck`, account_number: '5410', debit_amount: 500, credit_amount: 0, line_description: null, sort_order: 1 },
  ],
  added_lines: [
    { id: `${id}-added`, account_number: '5420', debit_amount: 500, credit_amount: 0, line_description: null, sort_order: 3 },
  ],
  actor,
  created_at,
})

type LogRow = { id: string; rattelse_type: string; actor: string | null; actor_label: string | null }

describe('GET /api/bookkeeping/journal-entries/[id]/rattelse-log', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    service.reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    createServiceClientMock.mockReturnValue(service.supabase)
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
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('returns the rättelse rows newest first with the actor resolved from profiles', async () => {
    enqueue({ data: { id: 'entry-1' }, error: null }) // ownership check
    enqueue({
      data: [
        linesRow('log-2', 'user-1', '2026-07-23T12:00:00Z'),
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
    service.enqueue({
      data: [{ id: 'user-1', email: 'anna@example.se', full_name: null }],
      error: null,
    })

    const response = await GET(makeGet(), params())
    const { body } = await parseJsonResponse<{ data: LogRow[] }>(response)

    expect(response.status).toBe(200)
    expect(body.data).toHaveLength(2)
    expect(body.data[0].id).toBe('log-2')
    expect(body.data[0].rattelse_type).toBe('lines')
    // Raw actor uuid is kept; the label is additive.
    expect(body.data[0].actor).toBe('user-1')
    expect(body.data[0].actor_label).toBe('anna@example.se')
    expect(body.data[1].actor_label).toBe('anna@example.se')
    // One lookup, scoped to exactly the distinct actor ids in the log rows.
    expect(service.findCalls('profiles', 'in')).toEqual([['id', ['user-1']]])
  })

  it('leaves actor_label null and skips the profiles lookup when no row has an actor', async () => {
    enqueue({ data: { id: 'entry-1' }, error: null }) // ownership check
    enqueue({ data: [linesRow('log-3', null, '2026-07-23T12:00:00Z')], error: null })

    const response = await GET(makeGet(), params())
    const { body } = await parseJsonResponse<{ data: LogRow[] }>(response)

    expect(response.status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].actor_label).toBeNull()
    expect(createServiceClientMock).not.toHaveBeenCalled()
    expect(service.findCalls('profiles', 'in')).toEqual([])
  })

  it('still returns 200 with actor_label null when the profiles lookup fails', async () => {
    enqueue({ data: { id: 'entry-1' }, error: null }) // ownership check
    enqueue({ data: [linesRow('log-4', 'user-2', '2026-07-23T12:00:00Z')], error: null })
    service.enqueue({ data: null, error: { message: 'permission denied' } })

    const response = await GET(makeGet(), params())
    const { body } = await parseJsonResponse<{ data: LogRow[] }>(response)

    expect(response.status).toBe(200)
    expect(body.data[0].actor).toBe('user-2')
    expect(body.data[0].actor_label).toBeNull()
  })

  it('still returns 200 with actor_label null when the service client cannot be created', async () => {
    enqueue({ data: { id: 'entry-1' }, error: null }) // ownership check
    enqueue({ data: [linesRow('log-5', 'user-2', '2026-07-23T12:00:00Z')], error: null })
    createServiceClientMock.mockImplementation(() => {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY missing')
    })

    const response = await GET(makeGet(), params())
    const { body } = await parseJsonResponse<{ data: LogRow[] }>(response)

    expect(response.status).toBe(200)
    expect(body.data[0].actor_label).toBeNull()
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
