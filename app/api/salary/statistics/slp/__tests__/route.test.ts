import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'
import type { SlpEmployeeInput } from '@/lib/salary/statistics/slp'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const collectSlpEmployees = vi.fn()
vi.mock('@/lib/salary/statistics/slp-data', () => ({
  collectSlpEmployees: (...args: unknown[]) => collectSlpEmployees(...args),
}))

import { GET } from '../route'

const url = '/api/salary/statistics/slp'

const sampleEmployee: SlpEmployeeInput = {
  personnummer: '199001011234',
  workerCategory: 'tjansteman',
  salaryType: 'monthly',
  ssykCode: '2611',
  cfarNumber: '12345678',
  arbetstidsart: '1',
  anstallningsform: '1',
  agreedWage: 42000,
  workedHours: 160,
  overtimeSupplement: 0,
  vacationDays: 25,
}

describe('GET /api/salary/statistics/slp', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    collectSlpEmployees.mockResolvedValue({ rows: [sampleEmployee] })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const res = await GET(createMockRequest(url, { searchParams: { year: '2026' } }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 400 when the year is missing', async () => {
    const res = await GET(createMockRequest(url))
    expect(res.status).toBe(400)
  })

  it('returns 400 when the year is out of range', async () => {
    const res = await GET(createMockRequest(url, { searchParams: { year: '1990' } }))
    expect(res.status).toBe(400)
  })

  it('returns 500 when data collection fails', async () => {
    collectSlpEmployees.mockResolvedValue({ rows: [], error: 'boom' })

    const res = await GET(createMockRequest(url, { searchParams: { year: '2026' } }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(500)
    expect(body).toEqual({ error: 'boom' })
  })

  it('scopes data collection to the resolved company and year', async () => {
    enqueue({ data: { org_number: '5560633517' } }) // companies

    await GET(createMockRequest(url, { searchParams: { year: '2026' } }))

    expect(collectSlpEmployees).toHaveBeenCalledWith(mockSupabase, 'company-1', 2026)
  })

  it('returns a fixed-position .txt file with one 300-char record per employee', async () => {
    enqueue({ data: { org_number: '5560633517' } }) // companies

    const res = await GET(createMockRequest(url, { searchParams: { year: '2026' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(res.headers.get('content-disposition')).toContain('SLP_2026.txt')

    const text = await res.text()
    expect(text).toHaveLength(300)
    expect(text).toContain('199001011234')
  })

  it('returns a JSON envelope when format=json', async () => {
    enqueue({ data: { org_number: '5560633517' } }) // companies

    const res = await GET(createMockRequest(url, { searchParams: { year: '2026', format: 'json' } }))
    const { status, body } = await parseJsonResponse<{
      data: { content: string; recordCount: number; incompleteCount: number }
    }>(res)

    expect(status).toBe(200)
    expect(body.data.recordCount).toBe(1)
    expect(body.data.incompleteCount).toBe(0)
  })
})
