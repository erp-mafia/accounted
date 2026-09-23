/**
 * GET /api/agent/conversations/[id] returns the conversation's still-open
 * proposals alongside its messages.
 *
 * Approval cards live in streamed events that are never persisted, so without
 * these rows a resumed thread renders the tool trace and the answer but drops
 * the card, and the proposal waits out its 30-day expiry in Granskning with
 * nothing in the conversation pointing at it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, enqueueMany, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { GET } from '../[id]/route'

const CONV = { id: 'conv-1', company_id: 'company-1', user_id: 'user-1', intent_id: 'general.help' }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mockSupabase, error: null })
})

describe('GET /api/agent/conversations/[id]', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const res = await GET(
      createMockRequest('/api/agent/conversations/conv-1'),
      createMockRouteParams({ id: 'conv-1' }),
    )
    expect((await parseJsonResponse(res)).status).toBe(401)
  })

  it('returns 404 for a conversation the caller does not own', async () => {
    enqueue({ data: null }) // conversation lookup filters on user_id

    const res = await GET(
      createMockRequest('/api/agent/conversations/conv-1'),
      createMockRouteParams({ id: 'conv-1' }),
    )
    expect((await parseJsonResponse(res)).status).toBe(404)
  })

  it('returns unanswered proposals alongside the messages', async () => {
    enqueueMany([
      { data: CONV },                                    // conversation
      { data: { role: 'owner' } },                       // company_members
      { data: [{ role: 'assistant', content: [] }] },    // agent_messages
      {
        data: [
          {
            id: 'op-1',
            operation_type: 'gnubok_categorize_transaction',
            title: 'Kontering: Circle K',
            risk_level: 'low',
            preview_data: {},
          },
        ],
      },                                                  // pending_operations
    ])

    const res = await GET(
      createMockRequest('/api/agent/conversations/conv-1'),
      createMockRouteParams({ id: 'conv-1' }),
    )
    const { status, body } = await parseJsonResponse<{
      data: { staged_operations: { id: string }[]; messages: unknown[] }
    }>(res)

    expect(status).toBe(200)
    expect(body.data.messages).toHaveLength(1)
    expect(body.data.staged_operations).toHaveLength(1)
    expect(body.data.staged_operations[0]!.id).toBe('op-1')
  })

  it('returns an empty list rather than failing when nothing is staged', async () => {
    enqueueMany([
      { data: CONV },
      { data: { role: 'owner' } },
      { data: [] },
      { data: null }, // no rows at all
    ])

    const res = await GET(
      createMockRequest('/api/agent/conversations/conv-1'),
      createMockRouteParams({ id: 'conv-1' }),
    )
    const { status, body } = await parseJsonResponse<{
      data: { staged_operations: unknown[] }
    }>(res)

    expect(status).toBe(200)
    expect(body.data.staged_operations).toEqual([])
  })
})
