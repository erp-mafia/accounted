import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-a') }))

import { requireAuth } from '@/lib/auth/require-auth'
import { GET } from '../route'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const ctx = { params: Promise.resolve({}) }
const get = () => GET(new Request('http://localhost/api/skills/usage'), ctx)

beforeEach(() => {
  vi.clearAllMocks(); reset()
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user' }, supabase, error: null } as never)
})

describe('GET /api/skills/usage', () => {
  it('requires authentication', async () => {
    vi.mocked(requireAuth).mockResolvedValue({ error: NextResponse.json({}, { status: 401 }) } as never)
    expect((await get()).status).toBe(401)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('counts loads per skill for the active company, Kvittojakten variants as one', async () => {
    enqueue({ data: [
      { sequence: 1, slug: 'bookkeep', created_at: '2026-09-01T10:00:00Z' },
      { sequence: 2, slug: 'kvittojakten-claude', created_at: '2026-09-02T10:00:00Z' },
      { sequence: 3, slug: 'bookkeep', created_at: '2026-09-20T10:00:00Z' },
      { sequence: 4, slug: 'kvittojakten', created_at: '2026-09-03T10:00:00Z' },
      { sequence: 5, slug: null, created_at: '2026-09-04T10:00:00Z' },
    ], error: null })
    const response = await get()
    expect(response.status).toBe(200)
    expect((await response.json()).data).toEqual({
      bookkeep: { count: 2, last_at: '2026-09-20T10:00:00Z' },
      kvittojakten: { count: 2, last_at: '2026-09-03T10:00:00Z' },
    })
    expect(findCalls('event_log', 'eq')).toEqual(expect.arrayContaining([['company_id', 'company-a'], ['event_type', 'mcp.skill_loaded']]))
  })
})
