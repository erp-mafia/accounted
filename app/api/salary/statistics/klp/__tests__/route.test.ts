import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse, createQueuedMockSupabase } from '@/tests/helpers'
import type { KlpRecord } from '@/lib/salary/statistics/klp'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

const url = '/api/salary/statistics/klp'

describe('GET /api/salary/statistics/klp', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const res = await GET(createMockRequest(url, { searchParams: { year: '2026', month: '1' } }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 400 when the month is out of range', async () => {
    const res = await GET(createMockRequest(url, { searchParams: { year: '2026', month: '0' } }))
    expect(res.status).toBe(400)
  })

  it('returns 500 when the salary_runs query fails', async () => {
    enqueue({ error: { message: 'runs exploded' } }) // salary_runs

    const res = await GET(createMockRequest(url, { searchParams: { year: '2026', month: '1' } }))
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(500)
    expect(body).toEqual({ error: 'runs exploded' })
  })

  it('returns an org-only .txt file when there are no runs in the month', async () => {
    enqueue({ data: [] }) // salary_runs → no runs
    enqueue({ data: { org_number: '5560633517' } }) // companies

    const res = await GET(createMockRequest(url, { searchParams: { year: '2026', month: '1' } }))

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(res.headers.get('content-disposition')).toContain('KLP_202601.txt')

    const text = await res.text()
    expect(text).toContain('OrgNummer;5560633517')
    expect(text).toContain('UtbManad;202601')
    expect(text).toContain('TMTFinns;2') // no employees in any bucket
  })

  it('aggregates a tjänsteman with their bonus line item (format=json)', async () => {
    enqueue({ data: [{ id: 'run-1' }] }) // salary_runs
    enqueue({
      data: [
        {
          id: 'sre-1',
          hours_worked: 160,
          employee: { worker_category: 'tjansteman', salary_type: 'monthly', monthly_salary: 40000, employment_degree: 100 },
        },
      ],
    }) // salary_run_employees
    enqueue({ data: [{ salary_run_employee_id: 'sre-1', amount: 300, item_type: 'bonus' }] }) // salary_line_items
    enqueue({ data: { org_number: '5560633517' } }) // companies

    const res = await GET(createMockRequest(url, { searchParams: { year: '2026', month: '1', format: 'json' } }))
    const { status, body } = await parseJsonResponse<{ data: KlpRecord; unclassified: number }>(res)

    expect(status).toBe(200)
    expect(body.data.tm.count).toBe(1)
    expect(body.data.tm.baseWage).toBe(40000)
    expect(body.data.tm.variableSupplement).toBe(300)
    expect(body.data.tm.workedHours).toBe(160)
    expect(body.data.tm.fte).toBe(1)
    expect(body.unclassified).toBe(0)
  })

  it('classifies hourly arbetare into the At bucket using hourly line items', async () => {
    enqueue({ data: [{ id: 'run-1' }] }) // salary_runs
    enqueue({
      data: [
        {
          id: 'sre-1',
          hours_worked: 168,
          employee: { worker_category: 'arbetare', salary_type: 'hourly', monthly_salary: null, employment_degree: 100 },
        },
      ],
    }) // salary_run_employees
    enqueue({ data: [{ salary_run_employee_id: 'sre-1', amount: 20000, item_type: 'hourly_salary' }] }) // salary_line_items
    enqueue({ data: { org_number: '5560633517' } }) // companies

    const res = await GET(createMockRequest(url, { searchParams: { year: '2026', month: '1', format: 'json' } }))
    const { body } = await parseJsonResponse<{ data: KlpRecord }>(res)

    expect(body.data.at.count).toBe(1)
    expect(body.data.at.baseWage).toBe(20000)
    expect(body.data.at.workedHours).toBe(168)
  })

  it('counts employees with no worker_category as unclassified (defaulting to tjänsteman)', async () => {
    enqueue({ data: [{ id: 'run-1' }] }) // salary_runs
    enqueue({
      data: [
        {
          id: 'sre-1',
          hours_worked: null,
          employee: { worker_category: null, salary_type: 'monthly', monthly_salary: 30000, employment_degree: 100 },
        },
      ],
    }) // salary_run_employees
    enqueue({ data: [] }) // salary_line_items
    enqueue({ data: { org_number: '5560633517' } }) // companies

    const res = await GET(createMockRequest(url, { searchParams: { year: '2026', month: '1', format: 'json' } }))
    const { body } = await parseJsonResponse<{ data: KlpRecord; unclassified: number }>(res)

    expect(body.unclassified).toBe(1)
    expect(body.data.tm.count).toBe(1)
  })
})
