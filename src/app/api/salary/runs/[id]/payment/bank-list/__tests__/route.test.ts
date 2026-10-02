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

import { GET } from '../route'

const URL = '/api/salary/runs/run-1/payment/bank-list'

const run = { id: 'run-1', status: 'approved', period_year: 2026, period_month: 4, payment_date: '2026-04-24' }
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

describe('GET /api/salary/runs/[id]/payment/bank-list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mockSupabase, error: null })
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
      createMockRequest(URL, { searchParams: { format: 'csv' } }),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('returns 404 SALARY_RUN_NOT_FOUND for an unknown run', async () => {
    enqueue({ data: null })
    const response = await GET(createMockRequest(URL), createMockRouteParams({ id: 'run-1' }))
    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.error.code).toBe('SALARY_RUN_NOT_FOUND')
  })

  it('refuses with the builder reason, naming the employees, when an account cannot be paid', async () => {
    enqueueMany([
      { data: run },
      { data: company },
      { data: settings },
      { data: [{ ...anna, employee: { ...anna.employee, clearing_number: '12' } }] },
    ])
    const response = await GET(createMockRequest(URL), createMockRouteParams({ id: 'run-1' }))
    expect(response.status).toBe(422)
    const body = await response.json()
    expect(body.error.code).toBe('SALARY_RUN_PAYMENT_FILE_EMPLOYEE_BANK_INVALID')
    expect(body.error.message).toContain('Anna Test')
    expect(JSON.stringify(body)).not.toContain('123456789')
  })

  it('returns the payee lines and total of the file, without archiving or stamping', async () => {
    enqueueMany([{ data: run }, { data: company }, { data: settings }, { data: [anna] }])
    const response = await GET(
      createMockRequest(URL, { searchParams: { format: 'bg_lb' } }),
      createMockRouteParams({ id: 'run-1' }),
    )
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data).toMatchObject({
      format: 'bg_lb',
      periodLabel: '2026-04',
      paymentDate: '2026-04-24',
      employeeCount: 1,
      totalAmount: 20000,
      payer: { name: 'Testbolaget AB', account: '5050-1055' },
      payees: [{ employeeId: 'emp-1', name: 'Anna Test', maskedAccount: '6000-****6789', amount: 20000, reference: '000018' }],
    })
    expect(body.data).not.toHaveProperty('content')
    expect(JSON.stringify(body)).not.toContain('123456789')
    expect(calls.some((c) => c.method === 'insert' || c.method === 'update')).toBe(false)
  })
})
