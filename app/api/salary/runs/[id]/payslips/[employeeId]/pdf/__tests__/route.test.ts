import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, createMockRouteParams } from '@/tests/helpers'

// The route is wrapped in withRouteContext. Auth/company are injected via the
// mocked requireAuth + getActiveCompanyId; the PDF pipeline is fully stubbed.
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getCompanyDisplayName: vi.fn().mockResolvedValue('Ny Firma AB'),
}))
vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: vi.fn(async () => Buffer.from('%PDF-fake')),
}))
vi.mock('@/lib/salary/pdf/payslip-template', () => ({ PayslipPDF: vi.fn(() => null) }))
vi.mock('@/lib/salary/payslips/build-payslip-data', () => ({
  buildPayslipData: vi.fn(() => ({})),
  payslipFileName: vi.fn(() => 'lonespec_Test_2026-06.pdf'),
}))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getCompanyDisplayName } from '@/lib/company/context'
import { buildPayslipData } from '@/lib/salary/payslips/build-payslip-data'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function authed() {
  const { supabase, enqueue, enqueueMany } = createQueuedMockSupabase()
  vi.mocked(requireAuth).mockResolvedValue({
    user: mockUser as never,
    supabase: supabase as never,
    error: null,
  })
  return { supabase, enqueue, enqueueMany }
}

describe('GET /api/salary/runs/[id]/payslips/[employeeId]/pdf', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCompanyDisplayName).mockResolvedValue('Ny Firma AB')
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null as never,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payslips/emp-1/pdf'),
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )
    expect(response.status).toBe(401)
  })

  it('returns 404 when the run does not exist', async () => {
    const { enqueueMany } = authed()
    enqueueMany([{ data: null }])
    const response = await GET(
      createMockRequest('/api/salary/runs/run-x/payslips/emp-1/pdf'),
      createMockRouteParams({ id: 'run-x', employeeId: 'emp-1' }),
    )
    expect(response.status).toBe(404)
  })

  it('renders the payslip PDF with the current company name', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', period_year: 2026, period_month: 6, payment_date: '2026-06-25' } },
      { data: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } },
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payslips/emp-1/pdf'),
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/pdf')
    // Employer name follows the current company_settings.company_name (resolved
    // by getCompanyDisplayName), not the frozen onboarding companies.name.
    expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(
      expect.objectContaining({ company: { name: 'Ny Firma AB', org_number: '5560000000' } }),
    )
  })

  it('falls back to companies.name when the resolver returns null', async () => {
    const { enqueueMany } = authed()
    vi.mocked(getCompanyDisplayName).mockResolvedValue(null)
    enqueueMany([
      { data: { id: 'run-1', period_year: 2026, period_month: 6, payment_date: '2026-06-25' } },
      { data: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } },
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payslips/emp-1/pdf'),
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )

    expect(response.status).toBe(200)
    expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(
      expect.objectContaining({ company: { name: 'Bolaget AB', org_number: '5560000000' } }),
    )
  })
})
