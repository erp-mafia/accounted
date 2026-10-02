import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-a') }))

import { requireAuth } from '@/lib/auth/require-auth'
import { POST } from '../route'

const { supabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
const ctx = { params: Promise.resolve({}) }
const post = (body: unknown) => POST(new Request('http://localhost/api/agents/community/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), ctx)
const SLUG = 'community/stang-dagskassan'

beforeEach(() => {
  vi.clearAllMocks(); reset()
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user-a' }, supabase, error: null } as never)
})

describe('POST /api/agents/community/feedback', () => {
  it('requires authentication', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ error: NextResponse.json({}, { status: 401 }) } as never)
    expect((await post({ slug: SLUG, vote: true })).status).toBe(401)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it.each([
    [{ slug: SLUG }],
    [{ slug: 'bookkeep', vote: true }],
    [{ slug: SLUG, vote: 'yes' }],
    [{ slug: SLUG, feedback: 'works' }],
    [{ slug: SLUG, vote: true, feedback: 'works' }],
    [{ slug: SLUG, vote: true, company_id: 'other' }],
  ])('rejects invalid input %j', async (body) => {
    expect((await post(body)).status).toBe(400)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('answers 404 for an item that is not a live community item', async () => {
    enqueue({ data: null })
    expect((await post({ slug: 'community/withdrawn', vote: true })).status).toBe(404)
    expect(findCalls('agent_atom_registry', 'eq')).toEqual(expect.arrayContaining([['tier', 'community'], ['is_active', true], ['mcp_exposed', true]]))
    expect(findCall('community_feedback', 'upsert')).toBeUndefined()
  })

  it('saves an upvote', async () => {
    enqueue({ data: { id: SLUG } }); enqueue({ data: { vote: true } })
    const response = await post({ slug: SLUG, vote: true })
    expect(response.status).toBe(200)
    expect((await response.json()).data).toEqual({ slug: SLUG, vote: true })
    expect(findCall('community_feedback', 'upsert')).toEqual([{ atom_id: SLUG, company_id: 'company-a', user_id: 'user-a', vote: true }, { onConflict: 'atom_id,user_id' }])
  })

  it('takes an upvote back', async () => {
    enqueue({ data: { id: SLUG } }); enqueue({ data: { vote: false } })
    expect((await post({ slug: SLUG, vote: false })).status).toBe(200)
    expect(findCall('community_feedback', 'upsert')?.[0]).toEqual({ atom_id: SLUG, company_id: 'company-a', user_id: 'user-a', vote: false })
  })
})
