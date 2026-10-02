import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase } from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, enqueueMany, reset, calls } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

// Layout is covered by the template test; here only the wiring matters.
const renderToBufferMock = vi.fn()
vi.mock('@react-pdf/renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@react-pdf/renderer')>()),
  renderToBuffer: (...args: unknown[]) => renderToBufferMock(...args),
}))

import { GET } from '../route'

const URL = '/api/salary/runs/run-1/payment/bank-list/pdf'

const run = { id: 'run-1', status: 'booked', period_year: 2026, period_month: 4, payment_date: '2026-04-24' }
const company = { name: 'Testbolaget AB', org_number: '556000-0000' }
const settings = {
  company_name: 'Testbolaget AB',
  iban: 'SE4550000000058398257466',
  bic: 'HANDSESS',
  clearing_number: '6000',
  bank_name: null,
  bankgiro: '5050-1055',
  preferred_payment_format: 'pain001',
}
const anna = {
  employee_id: 'emp-1',
  net_salary: 20000,
  tax_withheld: 6000,
  tax_withheld_override: null,
  employee: { first_name: 'Anna', last_name: 'Test', clearing_number: '6000', bank_account_number: '123456789', specification_number: 1 },
}

describe('GET /api/salary/runs/[id]/payment/bank-list/pdf', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mockSupabase, error: null })
    renderToBufferMock.mockResolvedValue(Buffer.from('%PDF-1.3 test'))
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await GET(createMockRequest(URL), createMockRouteParams({ id: 'run-1' }))
    expect(response.status).toBe(401)
  })

  it('returns 400 for an unknown format', async () => {
    const response = await GET(
      createMockRequest(URL, { searchParams: { format: 'xml' } }),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(400)
    expect(renderToBufferMock).not.toHaveBeenCalled()
  })

  it('returns 404 SALARY_RUN_NOT_FOUND for an unknown run', async () => {
    enqueue({ data: null })
    const response = await GET(createMockRequest(URL), createMockRouteParams({ id: 'run-1' }))
    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.error.code).toBe('SALARY_RUN_NOT_FOUND')
    expect(renderToBufferMock).not.toHaveBeenCalled()
  })

  it('returns 409 for a run whose payment file cannot be generated yet', async () => {
    enqueue({ data: { ...run, status: 'draft' } })
    const response = await GET(createMockRequest(URL), createMockRouteParams({ id: 'run-1' }))
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error.code).toBe('SALARY_RUN_PAYMENT_FILE_NOT_READY')
  })

  it('renders the bank list of the file, without archiving or stamping', async () => {
    enqueueMany([{ data: run }, { data: company }, { data: settings }, { data: [anna] }])
    const response = await GET(createMockRequest(URL), createMockRouteParams({ id: 'run-1' }))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/pdf')
    expect(response.headers.get('Content-Disposition')).toContain('banklista_lon_2026-04_pain001.pdf')
    expect(renderToBufferMock).toHaveBeenCalledTimes(1)
    expect(calls.some((c) => c.method === 'insert' || c.method === 'update')).toBe(false)
  })
})
