import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getCompanyDisplayName: vi.fn().mockResolvedValue('Testbolaget AB'),
}))

// Layout is covered by the template test; here only the wiring matters.
const renderToBufferMock = vi.fn()
vi.mock('@react-pdf/renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@react-pdf/renderer')>()),
  renderToBuffer: (...args: unknown[]) => renderToBufferMock(...args),
}))

import { GET } from '../route'

const URL = '/api/salary/runs/run-1/underlag/pdf'

const BOOKED_RUN = {
  id: 'run-1',
  company_id: 'company-1',
  status: 'booked',
  period_year: 2026,
  period_month: 8,
  payment_date: '2026-08-25',
  is_correction: false,
  salary_entry_id: 'je-1',
  avgifter_entry_id: null,
  vacation_entry_id: null,
  pension_entry_id: null,
}

describe('GET /api/salary/runs/[id]/underlag/pdf', () => {
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

  it('returns 404 SALARY_RUN_NOT_FOUND for an unknown run', async () => {
    enqueue({ data: null }) // salary_runs
    const response = await GET(createMockRequest(URL), createMockRouteParams({ id: 'run-1' }))
    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.error.code).toBe('SALARY_RUN_NOT_FOUND')
  })

  it('returns 409 for a run that is not booked yet', async () => {
    enqueue({ data: { ...BOOKED_RUN, status: 'approved' } })
    const response = await GET(createMockRequest(URL), createMockRouteParams({ id: 'run-1' }))
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error.code).toBe('SALARY_RUN_UNDERLAG_NOT_BOOKED')
    expect(renderToBufferMock).not.toHaveBeenCalled()
  })

  it('renders the PDF for a booked run', async () => {
    enqueue({ data: BOOKED_RUN }) // salary_runs
    enqueue({ data: { name: 'Testbolaget AB', org_number: '556677-8899' } }) // companies
    enqueue({ data: [] }) // salary_run_employees
    enqueue({
      data: [
        {
          id: 'je-1',
          description: 'Lön augusti 2026',
          voucher_series: 'L',
          voucher_number: 8,
          lines: [
            { account_number: '7210', line_description: '', debit_amount: 100, credit_amount: 0 },
            { account_number: '1930', line_description: '', debit_amount: 0, credit_amount: 100 },
          ],
        },
      ],
    }) // journal_entries
    enqueue({ data: [] }) // chart_of_accounts

    const response = await GET(createMockRequest(URL), createMockRouteParams({ id: 'run-1' }))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/pdf')
    expect(response.headers.get('Content-Disposition')).toContain('lonesammanstallning_2026-08.pdf')
    expect(renderToBufferMock).toHaveBeenCalledTimes(1)
  })
})
