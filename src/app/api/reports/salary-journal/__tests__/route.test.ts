import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/reports/salary-journal', () => ({
  generateSalaryJournal: vi.fn(),
}))

import { generateSalaryJournal } from '@/lib/reports/salary-journal'
import { GET } from '../route'

const mockGenerate = vi.mocked(generateSalaryJournal)
const call = (url: string) => GET(createMockRequest(url), createMockRouteParams({}))

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  mockGenerate.mockResolvedValue({ rows: [] } as never)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GET /api/reports/salary-journal', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await call('/api/reports/salary-journal?year=2026')).status).toBe(401)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('reports the year and months asked for', async () => {
    const { status, body } = await parseJsonResponse<{ data: unknown }>(
      await call('/api/reports/salary-journal?year=2025&month_from=2&month_to=3'),
    )
    expect(status).toBe(200)
    expect(body.data).toEqual({ rows: [] })
    expect(mockGenerate).toHaveBeenCalledWith(supabase, 'company-1', 2025, 2, 3)
  })

  it("takes the Swedish year when none is given, also on New Year's night", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-12-31T23:30:00Z'))
    await call('/api/reports/salary-journal')
    expect(mockGenerate).toHaveBeenCalledWith(supabase, 'company-1', 2027, undefined, undefined)
  })

  it('answers 500 when the report cannot be generated', async () => {
    mockGenerate.mockRejectedValue(new Error('boom'))
    expect((await call('/api/reports/salary-journal?year=2026')).status).toBe(500)
  })
})
