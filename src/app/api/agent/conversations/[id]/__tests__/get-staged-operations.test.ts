import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

/**
 * GET /api/agent/conversations/[id] hands a resumed thread its still-open
 * proposals. Each carries its operation_number, so the card in the thread
 * and the row in Rutin name the same proposal; while the column is not there
 * yet (the code is live before its migration) the proposals come without it.
 */

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...a: unknown[]) => requireAuthMock(...a) }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

const params = () => createMockRouteParams({ id: 'conv-1' })
const get = () => GET(createMockRequest('/api/agent/conversations/conv-1'), params())

const CONVERSATION = { id: 'conv-1', company_id: 'company-1', user_id: 'user-1' }
const OPEN = { id: 'op-1', operation_type: 'categorize_transaction', title: 'Kategorisera: Exempel AB', risk_level: 'low', preview_data: {} }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mockSupabase, error: null })
})

describe('GET /api/agent/conversations/[id]', () => {
  it('401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase: mockSupabase, error: NextResponse.json({ error: 'x' }, { status: 401 }) })
    expect((await parseJsonResponse(await get())).status).toBe(401)
  })

  it('404 when the conversation is not the caller’s', async () => {
    enqueue({ data: null })
    expect((await get()).status).toBe(404)
  })

  it('returns the open proposals with their number', async () => {
    enqueue({ data: CONVERSATION })
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: [] }) // messages
    enqueue({ data: [{ ...OPEN, operation_number: 128 }] })

    const { status, body } = await parseJsonResponse<{ data: { staged_operations: Array<Record<string, unknown>> } }>(await get())

    expect(status).toBe(200)
    expect(body.data.staged_operations).toEqual([{ ...OPEN, operation_number: 128 }])
    expect(String(findCalls('pending_operations', 'select')[0]?.[0])).toContain('operation_number')
  })

  it('returns them without a number while the column is not there yet', async () => {
    enqueue({ data: CONVERSATION })
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: [] }) // messages
    enqueue({ data: null, error: { code: '42703', message: 'column pending_operations.operation_number does not exist' } })
    enqueue({ data: [OPEN] })

    const { status, body } = await parseJsonResponse<{ data: { staged_operations: Array<Record<string, unknown>> } }>(await get())

    expect(status).toBe(200)
    expect(body.data.staged_operations).toEqual([OPEN])
    const selects = findCalls('pending_operations', 'select').map((args) => String(args[0]))
    expect(selects).toHaveLength(2)
    expect(selects[1]).not.toContain('operation_number')
  })

  it('still fails loudly on any other read error, so open proposals are never dropped in silence', async () => {
    enqueue({ data: CONVERSATION })
    enqueue({ data: { role: 'owner' } })
    enqueue({ data: [] }) // messages
    enqueue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })

    // A statement timeout is answered as a transient failure, and not retried here.
    expect((await get()).status).toBe(503)
    expect(findCalls('pending_operations', 'select')).toHaveLength(1)
  })
})
