import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/reports/journal-register', () => ({
  generateJournalRegisterPage: vi.fn(),
}))

import { generateJournalRegisterPage } from '@/lib/reports/journal-register'
import { GET } from '../route'

const mockPage = vi.mocked(generateJournalRegisterPage)
const noParams = { params: Promise.resolve({}) }
const ENTRY_ID = '00000000-0000-4000-8000-000000000007'

function request(searchParams: Record<string, string>) {
  return createMockRequest('/api/reports/journal-register/page', { searchParams })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
})

describe('GET /api/reports/journal-register/page', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(request({ period_id: 'period-1' }), noParams)
    expect(res.status).toBe(401)
  })

  it('returns 400 without a period', async () => {
    const res = await GET(request({}), noParams)
    expect(res.status).toBe(400)
  })

  it('returns 400 for a partial or malformed cursor', async () => {
    const cursors: Array<Record<string, string>> = [
      { after_series: 'A' },
      { after_series: 'A', after_number: 'x', after_id: ENTRY_ID },
      { after_series: 'A', after_number: '12', after_id: 'not-a-uuid' },
      { after_series: '', after_number: '12', after_id: ENTRY_ID },
    ]
    for (const cursor of cursors) {
      const res = await GET(request({ period_id: 'period-1', ...cursor }), noParams)
      expect(res.status).toBe(400)
    }
    expect(mockPage).not.toHaveBeenCalled()
  })

  it('reads the first page without a cursor and the next one after it', async () => {
    const page = { entries: [], next: null }
    mockPage.mockResolvedValue(page)

    const first = await GET(request({ period_id: 'period-1' }), noParams)
    expect(first.status).toBe(200)
    expect(mockPage).toHaveBeenLastCalledWith(supabase, 'company-1', 'period-1', { after: undefined })

    const next = await GET(request({ period_id: 'period-1', after_series: 'B', after_number: '12', after_id: ENTRY_ID }), noParams)
    const { status, body } = await parseJsonResponse<{ data: typeof page }>(next)
    expect(status).toBe(200)
    expect(body.data).toEqual(page)
    expect(mockPage).toHaveBeenLastCalledWith(supabase, 'company-1', 'period-1', {
      after: { voucher_series: 'B', voucher_number: 12, id: ENTRY_ID },
    })
  })
})
