import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, createMockRouteParams, parseJsonResponse } from '@/tests/helpers'

// The route is wrapped in withRouteContext. Auth/company are injected via the
// mocked requireAuth + getActiveCompanyId; the PDF pipeline is fully stubbed.
const { SERVICE_CLIENT } = vi.hoisted(() => ({ SERVICE_CLIENT: { service: true } }))

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
vi.mock('@/lib/salary/payslips/build-payslip-data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/salary/payslips/build-payslip-data')>()
  return {
    ...actual,
    buildPayslipData: vi.fn(() => ({})),
    payslipFileName: vi.fn(() => 'lonespec_Test_2026-06.pdf'),
  }
})

vi.mock('@/lib/salary/payslips/section-snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/payslips/section-snapshot')>()),
  issuePayslipSections: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => SERVICE_CLIENT) }))
vi.mock('@/lib/auth/require-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/require-write')>()),
  requireWritePermission: vi.fn(),
}))

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'
import { getCompanyDisplayName } from '@/lib/company/context'
import { buildPayslipData } from '@/lib/salary/payslips/build-payslip-data'
import { issuePayslipSections } from '@/lib/salary/payslips/section-snapshot'
import { requireWritePermission } from '@/lib/auth/require-write'
import { createServiceClient } from '@/lib/supabase/server'

const mockUser = { id: 'user-1', email: 'test@test.se' }
const NOT_ISSUED = {
  payslip_sections_issued_at: null,
  payslip_show_employer_cost: null,
  payslip_show_breakdown: null,
}

function authed() {
  const { supabase, enqueue, enqueueMany } = createQueuedMockSupabase()
  vi.mocked(requireAuth).mockResolvedValue({
    user: mockUser as never,
    supabase: supabase as never,
    error: null,
  })
  return { supabase, enqueue, enqueueMany }
}

// CodeRabbit on #3336: every failure is the canonical envelope withRouteContext
// builds, never a hand-built { error: string }.
async function expectEnvelope(response: Response, status: number, code: string) {
  const { status: actual, body } = await parseJsonResponse(response)
  expect(actual).toBe(status)
  const envelope = (body as { error: Record<string, unknown> }).error
  expect(envelope).toMatchObject({
    code,
    message: expect.any(String),
    message_en: expect.any(String),
    requestId: expect.stringMatching(/^req_/),
  })
  expect(response.headers.get('X-Request-Id')).toBe(envelope.requestId)
  return envelope
}

describe('GET /api/salary/runs/[id]/payslips/[employeeId]/pdf', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCompanyDisplayName).mockResolvedValue('Ny Firma AB')
    vi.mocked(issuePayslipSections).mockResolvedValue({ ok: true, snapshot: NOT_ISSUED })
    vi.mocked(requireWritePermission).mockResolvedValue({ ok: true })
  })

  function viewer() {
    vi.mocked(requireWritePermission).mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Du har endast läsbehörighet i detta företag.' }, { status: 403 }),
    })
  }

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

  it('renders the employer view with every section when no audience is given', async () => {
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
    expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(
      expect.objectContaining({ audience: { kind: 'employer' } }),
    )
  })

  it('renders the employee copy with the company section switches for ?audience=employee', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', period_year: 2026, period_month: 6, payment_date: '2026-06-25' } },
      { data: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } },
      { data: { salary_payslip_show_employer_cost: false, salary_payslip_show_breakdown: false } },
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payslips/emp-1/pdf', { searchParams: { audience: 'employee' } }),
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )

    expect(response.status).toBe(200)
    expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: {
          kind: 'employee',
          settings: { salary_payslip_show_employer_cost: false, salary_payslip_show_breakdown: false },
        },
      }),
    )
  })

  it('returns 500 in the canonical envelope instead of printing hidden sections when the switches cannot be read', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', period_year: 2026, period_month: 6, payment_date: '2026-06-25' } },
      { data: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } },
      { data: null, error: { message: 'timeout' } },
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payslips/emp-1/pdf', { searchParams: { audience: 'employee' } }),
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )

    const envelope = await expectEnvelope(response, 500, 'INTERNAL_ERROR')
    expect(envelope.message).toBe('Kunde inte läsa lönespecifikationens inställningar')
    // The driver's message stays in the log, never in the body.
    expect(JSON.stringify(envelope)).not.toContain('timeout')
    expect(vi.mocked(buildPayslipData)).not.toHaveBeenCalled()
  })

  it('issues the run for a member who may write it, and renders what was issued', async () => {
    const { supabase, enqueueMany } = authed()
    const run = { id: 'run-1', status: 'paid', period_year: 2026, period_month: 6, payment_date: '2026-06-25' }
    const hiddenNow = { salary_payslip_show_employer_cost: false, salary_payslip_show_breakdown: false }
    enqueueMany([
      { data: run },
      { data: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } },
      { data: hiddenNow },
    ])
    const issuedShown = {
      payslip_sections_issued_at: '2026-06-24T08:00:00.000Z',
      payslip_show_employer_cost: true,
      payslip_show_breakdown: true,
    }
    vi.mocked(issuePayslipSections).mockResolvedValue({ ok: true, snapshot: issuedShown })

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payslips/emp-1/pdf', { searchParams: { audience: 'employee' } }),
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )

    expect(response.status).toBe(200)
    // A writer handing out the copy issues the run through its own RLS-scoped
    // client, scoped to the active company; never the service role.
    expect(vi.mocked(requireWritePermission)).toHaveBeenCalledWith(supabase, 'user-1', { companyId: 'company-1' })
    expect(vi.mocked(issuePayslipSections)).toHaveBeenCalledWith(supabase, {
      companyId: 'company-1',
      run,
      settings: hiddenNow,
    })
    expect(vi.mocked(createServiceClient)).not.toHaveBeenCalled()
    expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(
      expect.objectContaining({ run: { ...run, ...issuedShown } }),
    )
  })

  it('never issues the run for a read-only member: the copy follows the live switches', async () => {
    viewer()
    const { enqueueMany } = authed()
    const run = { id: 'run-1', status: 'paid', period_year: 2026, period_month: 6, payment_date: '2026-06-25', ...NOT_ISSUED }
    const hiddenNow = { salary_payslip_show_employer_cost: false, salary_payslip_show_breakdown: false }
    enqueueMany([
      { data: run },
      { data: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } },
      { data: hiddenNow },
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payslips/emp-1/pdf', { searchParams: { audience: 'employee' } }),
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )

    // A read never causes a permanent write: no snapshot, no service role.
    expect(response.status).toBe(200)
    expect(vi.mocked(issuePayslipSections)).not.toHaveBeenCalled()
    expect(vi.mocked(createServiceClient)).not.toHaveBeenCalled()
    expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(
      expect.objectContaining({ run, audience: { kind: 'employee', settings: hiddenNow } }),
    )
  })

  it('renders a read-only member the sections an issued run was issued with, writing nothing', async () => {
    viewer()
    const { enqueueMany } = authed()
    const run = {
      id: 'run-1',
      status: 'booked',
      period_year: 2026,
      period_month: 6,
      payment_date: '2026-06-25',
      payslip_sections_issued_at: '2026-06-24T08:00:00.000Z',
      payslip_show_employer_cost: true,
      payslip_show_breakdown: true,
    }
    enqueueMany([
      { data: run },
      { data: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } },
      { data: { salary_payslip_show_employer_cost: false, salary_payslip_show_breakdown: false } },
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payslips/emp-1/pdf', { searchParams: { audience: 'employee' } }),
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )

    expect(response.status).toBe(200)
    expect(vi.mocked(issuePayslipSections)).not.toHaveBeenCalled()
    // The stored snapshot travels on the run; payslipSectionsFor prints it
    // whatever the switches say now.
    expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(expect.objectContaining({ run }))
  })

  it('returns 500 in the canonical envelope when the issued sections cannot be fixed', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'approved', period_year: 2026, period_month: 6, payment_date: '2026-06-25' } },
      { data: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } },
      { data: { salary_payslip_show_employer_cost: true, salary_payslip_show_breakdown: true } },
    ])
    vi.mocked(issuePayslipSections).mockResolvedValue({ ok: false, error: new Error('timeout') })

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payslips/emp-1/pdf', { searchParams: { audience: 'employee' } }),
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )

    const envelope = await expectEnvelope(response, 500, 'INTERNAL_ERROR')
    expect(envelope.message).toBe('Kunde inte läsa lönespecifikationens inställningar')
    expect(JSON.stringify(envelope)).not.toContain('timeout')
    expect(vi.mocked(buildPayslipData)).not.toHaveBeenCalled()
  })

  it('never issues the run for the employer view', async () => {
    const { enqueueMany } = authed()
    enqueueMany([
      { data: { id: 'run-1', status: 'booked', period_year: 2026, period_month: 6, payment_date: '2026-06-25' } },
      { data: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] } },
      { data: { name: 'Bolaget AB', org_number: '5560000000' } },
    ])

    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payslips/emp-1/pdf'),
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )

    expect(response.status).toBe(200)
    expect(vi.mocked(issuePayslipSections)).not.toHaveBeenCalled()
  })

  it('returns 400 in the canonical envelope for an unknown audience', async () => {
    authed()
    const response = await GET(
      createMockRequest('/api/salary/runs/run-1/payslips/emp-1/pdf', { searchParams: { audience: 'auditor' } }),
      createMockRouteParams({ id: 'run-1', employeeId: 'emp-1' }),
    )
    const envelope = await expectEnvelope(response, 400, 'VALIDATION_ERROR')
    expect(envelope).toMatchObject({ message: 'Ogiltig mottagare för lönespecifikationen', details: { field: 'audience' } })
    expect(vi.mocked(buildPayslipData)).not.toHaveBeenCalled()
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
