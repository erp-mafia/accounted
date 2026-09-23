import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { createClient } from '@/lib/supabase/server'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { GET } from '../route'

function mkReq() {
  return new Request('http://localhost/api/bookkeeping/fiscal-periods/period-1/entry-count')
}

function mkParams(id = 'period-1') {
  return { params: Promise.resolve({ id }) }
}

describe('GET /api/bookkeeping/fiscal-periods/[id]/entry-count', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when unauthenticated', async () => {
    const { supabase } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const res = await GET(mkReq(), mkParams())
    expect(res.status).toBe(401)
  })

  it('returns 404 when period does not belong to company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    enqueue({ data: null, error: null })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const res = await GET(mkReq(), mkParams())
    expect(res.status).toBe(404)
  })

  it('returns posted count on happy path', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    // fiscal_periods lookup
    enqueue({ data: { id: 'period-1' }, error: null })
    // journal_entries count
    enqueue({ count: 3, error: null })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const res = await GET(mkReq(), mkParams())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.posted_count).toBe(3)
  })

  it('returns 0 when no posted entries exist', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    enqueue({ data: { id: 'period-1' }, error: null })
    enqueue({ count: 0, error: null })
    vi.mocked(createClient).mockResolvedValue(supabase as never)

    const res = await GET(mkReq(), mkParams())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.posted_count).toBe(0)
  })
})
