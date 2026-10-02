import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase, createMockRequest, createMockRouteParams } from '@/tests/helpers'

vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn() }))
vi.mock('@/lib/salary/payslips/links', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/salary/payslips/links')>()
  return {
    ...actual,
    resolvePayslipToken: vi.fn(),
  }
})
vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: vi.fn(async () => Buffer.from('%PDF-fake')),
}))
vi.mock('@/lib/salary/pdf/payslip-template', () => ({ PayslipPDF: vi.fn(() => null) }))
vi.mock('@/lib/salary/payslips/build-payslip-data', () => ({
  buildPayslipData: vi.fn(() => ({})),
  payslipFileName: vi.fn(() => 'lonespec_Test_2026-06.pdf'),
}))
vi.mock('@/lib/salary/payslips/section-snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/payslips/section-snapshot')>()),
  issuePayslipSections: vi.fn(),
}))

import { GET } from '../route'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { resolvePayslipToken } from '@/lib/salary/payslips/links'
import { buildPayslipData } from '@/lib/salary/payslips/build-payslip-data'
import { issuePayslipSections } from '@/lib/salary/payslips/section-snapshot'

const NOT_ISSUED = {
  payslip_sections_issued_at: null,
  payslip_show_employer_cost: null,
  payslip_show_breakdown: null,
}

function liveLink() {
  return {
    ok: true as const,
    link: {
      id: 'link-1',
      company_id: 'company-1',
      salary_run_id: 'run-1',
      employee_id: 'emp-1',
      token_hash: 'h',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      revoked_at: null,
      access_count: 0,
    },
  }
}

// Distinct valid-format tokens per test — the route's rate-limit map is
// module-level state shared across this file.
const token = (c: string) => c.repeat(43)

describe('GET /api/payslip/[token]/pdf', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const { supabase } = createQueuedMockSupabase()
    vi.mocked(createServiceClientNoCookies).mockReturnValue(supabase as never)
    vi.mocked(issuePayslipSections).mockResolvedValue({ ok: true, snapshot: NOT_ISSUED })
  })

  it('returns 400 for malformed tokens', async () => {
    const request = createMockRequest('/api/payslip/x/pdf')
    const response = await GET(request, createMockRouteParams({ token: 'not-a-token' }))
    expect(response.status).toBe(400)
    expect(vi.mocked(resolvePayslipToken)).not.toHaveBeenCalled()
  })

  it('returns 404 for an unknown token', async () => {
    vi.mocked(resolvePayslipToken).mockResolvedValue({ ok: false, reason: 'not_found' })
    const request = createMockRequest('/api/payslip/t/pdf')
    const response = await GET(request, createMockRouteParams({ token: token('B') }))
    expect(response.status).toBe(404)
  })

  it('returns 410 for expired and revoked tokens', async () => {
    vi.mocked(resolvePayslipToken).mockResolvedValue({ ok: false, reason: 'expired' })
    let response = await GET(
      createMockRequest('/api/payslip/t/pdf'),
      createMockRouteParams({ token: token('C') }),
    )
    expect(response.status).toBe(410)

    vi.mocked(resolvePayslipToken).mockResolvedValue({ ok: false, reason: 'revoked' })
    response = await GET(
      createMockRequest('/api/payslip/t/pdf'),
      createMockRouteParams({ token: token('D') }),
    )
    expect(response.status).toBe(410)
  })

  it('rate limits repeated requests per token', async () => {
    vi.mocked(resolvePayslipToken).mockResolvedValue({ ok: false, reason: 'not_found' })
    const t = token('E')
    let last: Response | null = null
    for (let i = 0; i < 21; i++) {
      last = await GET(
        createMockRequest('/api/payslip/t/pdf'),
        createMockRouteParams({ token: t }),
      )
    }
    expect(last?.status).toBe(429)
  })

  it('streams the PDF with no-store for a live token', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    vi.mocked(createServiceClientNoCookies).mockReturnValue(supabase as never)
    vi.mocked(resolvePayslipToken).mockResolvedValue({
      ok: true,
      link: {
        id: 'link-1',
        company_id: 'company-1',
        salary_run_id: 'run-1',
        employee_id: 'emp-1',
        token_hash: 'h',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        revoked_at: null,
        access_count: 0,
      },
    })
    enqueueMany([
      { data: { id: 'run-1', period_year: 2026, period_month: 6, payment_date: '2026-06-25' } },
      { data: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] } },
      { data: { name: 'Bolaget AB', org_number: null } },
      {
        data: {
          company_name: 'Ny Firma AB',
          salary_payslip_show_employer_cost: false,
          salary_payslip_show_breakdown: true,
        },
      },
    ])

    const response = await GET(
      createMockRequest('/api/payslip/t/pdf'),
      createMockRouteParams({ token: token('F') }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/pdf')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Content-Disposition')).toContain('lonespec_Test_2026-06.pdf')
    // Employer name follows the current company_settings.company_name, not the
    // frozen onboarding companies.name.
    expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(
      expect.objectContaining({ company: { name: 'Ny Firma AB', org_number: null } }),
    )
    // The link is the employee's copy: the company's section switches travel
    // with it (crm#202).
    expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: {
          kind: 'employee',
          settings: expect.objectContaining({
            salary_payslip_show_employer_cost: false,
            salary_payslip_show_breakdown: true,
          }),
        },
      }),
    )
  })

  it('falls back to companies.name when company_settings has no company_name', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    vi.mocked(createServiceClientNoCookies).mockReturnValue(supabase as never)
    vi.mocked(resolvePayslipToken).mockResolvedValue({
      ok: true,
      link: {
        id: 'link-1',
        company_id: 'company-1',
        salary_run_id: 'run-1',
        employee_id: 'emp-1',
        token_hash: 'h',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        revoked_at: null,
        access_count: 0,
      },
    })
    enqueueMany([
      { data: { id: 'run-1', period_year: 2026, period_month: 6, payment_date: '2026-06-25' } },
      { data: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } },
      { data: { company_name: null } },
    ])

    const response = await GET(
      createMockRequest('/api/payslip/t/pdf'),
      createMockRouteParams({ token: token('G') }),
    )

    expect(response.status).toBe(200)
    expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(
      expect.objectContaining({ company: { name: 'Bolaget AB', org_number: '5560000000' } }),
    )
  })

  it('returns 500 instead of printing hidden sections when the switches cannot be read', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    vi.mocked(createServiceClientNoCookies).mockReturnValue(supabase as never)
    vi.mocked(resolvePayslipToken).mockResolvedValue({
      ok: true,
      link: {
        id: 'link-1',
        company_id: 'company-1',
        salary_run_id: 'run-1',
        employee_id: 'emp-1',
        token_hash: 'h',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        revoked_at: null,
        access_count: 0,
      },
    })
    enqueueMany([
      { data: { id: 'run-1', period_year: 2026, period_month: 6, payment_date: '2026-06-25' } },
      { data: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } },
      { data: null, error: { message: 'timeout' } },
    ])

    const response = await GET(
      createMockRequest('/api/payslip/t/pdf'),
      createMockRouteParams({ token: token('H') }),
    )

    expect(response.status).toBe(500)
    expect(vi.mocked(buildPayslipData)).not.toHaveBeenCalled()
  })
  it('renders the sections the run was issued with, not the switches as they are now', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    vi.mocked(createServiceClientNoCookies).mockReturnValue(supabase as never)
    vi.mocked(resolvePayslipToken).mockResolvedValue(liveLink())
    const run = { id: 'run-1', status: 'booked', period_year: 2026, period_month: 6, payment_date: '2026-06-25' }
    const hiddenNow = {
      company_name: null,
      salary_payslip_show_employer_cost: false,
      salary_payslip_show_breakdown: false,
    }
    enqueueMany([
      { data: run },
      { data: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] } },
      { data: { name: 'Bolaget AB', org_number: null } },
      { data: hiddenNow },
    ])
    const issuedShown = {
      payslip_sections_issued_at: '2026-06-24T08:00:00.000Z',
      payslip_show_employer_cost: true,
      payslip_show_breakdown: true,
    }
    vi.mocked(issuePayslipSections).mockResolvedValue({ ok: true, snapshot: issuedShown })

    const response = await GET(
      createMockRequest('/api/payslip/t/pdf'),
      createMockRouteParams({ token: token('I') }),
    )

    expect(response.status).toBe(200)
    expect(vi.mocked(issuePayslipSections)).toHaveBeenCalledWith(supabase, {
      companyId: 'company-1',
      run,
      settings: hiddenNow,
    })
    expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(
      expect.objectContaining({ run: { ...run, ...issuedShown } }),
    )
  })

  it('returns 500 and renders nothing when the issued sections cannot be fixed or read', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    vi.mocked(createServiceClientNoCookies).mockReturnValue(supabase as never)
    vi.mocked(resolvePayslipToken).mockResolvedValue(liveLink())
    enqueueMany([
      { data: { id: 'run-1', status: 'approved', period_year: 2026, period_month: 6, payment_date: '2026-06-25' } },
      { data: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] } },
      { data: { name: 'Bolaget AB', org_number: null } },
      { data: { company_name: null } },
    ])
    vi.mocked(issuePayslipSections).mockResolvedValue({ ok: false, error: new Error('timeout') })

    const response = await GET(
      createMockRequest('/api/payslip/t/pdf'),
      createMockRouteParams({ token: token('J') }),
    )

    expect(response.status).toBe(500)
    expect(vi.mocked(buildPayslipData)).not.toHaveBeenCalled()
  })
})
