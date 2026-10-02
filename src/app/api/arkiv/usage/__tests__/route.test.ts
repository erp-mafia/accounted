import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn() }))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getActiveCompanyId } from '@/lib/company/context'

const call = () => GET(new Request('http://localhost/api/arkiv/usage'), {} as never)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.ARKIV_COMPANY_IDS = 'company-1'
  ;(requireAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ user: { id: 'user-1', email: 't@t.se' }, supabase: mockSupabase })
  ;(getActiveCompanyId as ReturnType<typeof vi.fn>).mockResolvedValue('company-1')
})

describe('GET /api/arkiv/usage', () => {

  it('sums the rolling year per activity for the company', async () => {
    enqueue({ data: [{ activity: 'documents', units: 3 }, { activity: 'documents', units: 2 }, { activity: 'pages_read', units: 40 }, { activity: 'asks', units: 1 }, { activity: 'nonsense', units: 9 }] })
    const { status, body } = await parseJsonResponse(await call())
    expect(status).toBe(200)
    expect(body).toMatchObject({ data: { days: 365, documents: 5, pages_read: 40, pages_vision: 0, extractions: 0, asks: 1 } })
    expect((body as { data: { since: string } }).data.since).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(findCalls('arkiv_usage_daily', 'eq')).toEqual([['company_id', 'company-1']])
    expect(findCalls('arkiv_usage_daily', 'gte')[0]?.[0]).toBe('day')
  })

  it('is 500 with a message when the read fails', async () => {
    enqueue({ error: { message: 'boom' } })
    expect((await parseJsonResponse(await call())).status).toBe(500)
  })
})
