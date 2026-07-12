/**
 * Tests for GET /api/agent/conversations and GET/PATCH /api/agent/conversations/[id].
 *
 * Uses a filter-capturing Supabase mock so the user-scoping regression is
 * locked in: RLS on agent_conversations is company-scoped, so the explicit
 * .eq('user_id', …) filter in the list route is the only thing preventing
 * team members from seeing each other's conversation titles/previews.
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

import { GET as listGET } from '../conversations/route'
import { GET as detailGET, PATCH as detailPATCH } from '../conversations/[id]/route'

interface CapturedCall {
  method: string
  args: unknown[]
}

/** Chainable builder that records every call and resolves queued results per from(). */
function createCapturingSupabase(results: { data?: unknown; error?: unknown }[]) {
  const calls: CapturedCall[] = []
  let idx = 0
  const makeBuilder = () => {
    const result = results[idx++] ?? { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {}
    for (const m of ['select', 'eq', 'is', 'or', 'order', 'limit', 'insert', 'update', 'maybeSingle', 'single']) {
      b[m] = (...args: unknown[]) => {
        calls.push({ method: m, args })
        return b
      }
    }
    b.then = (resolve: (v: unknown) => void) =>
      resolve({ data: result.data ?? null, error: result.error ?? null, count: null })
    return b
  }
  const supabase = {
    from: (table: string) => {
      calls.push({ method: 'from', args: [table] })
      return makeBuilder()
    },
  }
  return { supabase, calls }
}

const routeParams = { params: Promise.resolve({}) }
const idParams = { params: Promise.resolve({ id: 'conv-1' }) }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/agent/conversations', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const res = await listGET(createMockRequest('/api/agent/conversations'), routeParams)
    expect(res.status).toBe(401)
  })

  it('returns 400 for a non-numeric limit', async () => {
    const { supabase } = createCapturingSupabase([])
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })

    const req = createMockRequest('/api/agent/conversations', { searchParams: { limit: 'abc' } })
    const { status } = await parseJsonResponse(await listGET(req, routeParams))
    expect(status).toBe(400)
  })

  it('filters the list by BOTH company_id and the calling user_id', async () => {
    const { supabase, calls } = createCapturingSupabase([
      { data: [{ id: 'conv-1', title: 'Min konversation' }] },
    ])
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })

    const req = createMockRequest('/api/agent/conversations')
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(
      await listGET(req, routeParams)
    )

    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    const eqCalls = calls.filter((c) => c.method === 'eq').map((c) => c.args)
    expect(eqCalls).toContainEqual(['company_id', 'company-1'])
    // Privacy regression guard: without this filter, company-scoped RLS lets
    // every member read colleagues' titles and last_message_preview.
    expect(eqCalls).toContainEqual(['user_id', 'user-1'])
  })
})

describe('GET /api/agent/conversations/[id]', () => {
  it('returns 404 when the conversation is not owned by the caller', async () => {
    // Ownership is part of the fetch (.eq user_id) — a non-owned id resolves null.
    const { supabase, calls } = createCapturingSupabase([{ data: null }])
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await detailGET(createMockRequest('/api/agent/conversations/conv-1'), idParams)
    )

    expect(status).toBe(404)
    expect(body.error.code).toBe('CONVERSATION_NOT_FOUND')
    const eqCalls = calls.filter((c) => c.method === 'eq').map((c) => c.args)
    expect(eqCalls).toContainEqual(['user_id', 'user-1'])
  })

  it('returns the conversation with its messages for the owner', async () => {
    const { supabase } = createCapturingSupabase([
      { data: { id: 'conv-1', company_id: 'company-1', user_id: 'user-1', title: 'T' } },
      { data: { role: 'member' } },
      { data: [{ id: 'm1', role: 'user', content: 'Hej' }] },
    ])
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })

    const { status, body } = await parseJsonResponse<{
      data: { conversation: { id: string }; messages: unknown[] }
    }>(await detailGET(createMockRequest('/api/agent/conversations/conv-1'), idParams))

    expect(status).toBe(200)
    expect(body.data.conversation.id).toBe('conv-1')
    expect(body.data.messages).toHaveLength(1)
  })
})

describe('PATCH /api/agent/conversations/[id]', () => {
  it('returns 400 when the body has nothing to update', async () => {
    const { supabase } = createCapturingSupabase([])
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })

    const req = createMockRequest('/api/agent/conversations/conv-1', {
      method: 'PATCH',
      body: {},
    })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await detailPATCH(req, idParams)
    )

    expect(status).toBe(400)
    expect(body.error.code).toBe('NOTHING_TO_UPDATE')
  })

  it('updates pin state for an owned conversation', async () => {
    const { supabase } = createCapturingSupabase([
      { data: { user_id: 'user-1', company_id: 'company-1' } },
      { data: { id: 'conv-1', pinned: true } },
    ])
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })

    const req = createMockRequest('/api/agent/conversations/conv-1', {
      method: 'PATCH',
      body: { pinned: true },
    })
    const { status, body } = await parseJsonResponse<{ data: { pinned: boolean } }>(
      await detailPATCH(req, idParams)
    )

    expect(status).toBe(200)
    expect(body.data.pinned).toBe(true)
  })
})
