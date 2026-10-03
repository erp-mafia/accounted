/**
 * ASVS V8.2.1: the payslip PDF endpoint returns full personnummer-bearing
 * payroll data, so the binding between the API key's user and the
 * `[companyId]` path segment must be enforced server-side BEFORE any payslip
 * data is read. The check lives in withApiV1 (company_members lookup); these
 * tests pin it to this concrete route so a wrapper regression or a future
 * unwrapped rewrite of the route fails loudly here.
 *
 * Deliberate convention: the deny case is 404 (not 403) so an unauthorized
 * caller cannot probe which company ids exist (see DECISIONS.md).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})

vi.mock('@/lib/api/idempotency', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/idempotency')>(
    '@/lib/api/idempotency',
  )
  return {
    ...actual,
    checkIdempotencyKey: vi.fn(),
    storeIdempotencyResponse: vi.fn(),
  }
})

// PDF rendering is irrelevant to the auth surface under test; keep the test
// hermetic (no @react-pdf font/layout machinery).
vi.mock('@react-pdf/renderer', () => ({ renderToBuffer: vi.fn() }))
vi.mock('@/lib/salary/pdf/payslip-template', () => ({ PayslipPDF: vi.fn() }))
vi.mock('@/lib/salary/payslips/build-payslip-data', () => ({
  buildPayslipData: vi.fn(),
  payslipFileName: vi.fn(() => 'payslip.pdf'),
}))
vi.mock('@/lib/company/context', () => ({ getCompanyDisplayName: vi.fn() }))
vi.mock('@/lib/salary/payslips/section-snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/payslips/section-snapshot')>()),
  issuePayslipSections: vi.fn(),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { renderToBuffer } from '@react-pdf/renderer'
import { buildPayslipData } from '@/lib/salary/payslips/build-payslip-data'
import { issuePayslipSections } from '@/lib/salary/payslips/section-snapshot'
import { GET } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_A = '11111111-1111-4111-8111-111111111111'
const RUN_ID = '22222222-2222-4222-8222-222222222222'
const EMPLOYEE_ID = '33333333-3333-4333-8333-333333333333'

function makeSupabaseStub(membership: { company_id: string; role: string } | null) {
  const from = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: membership, error: null }),
        }),
      }),
    }),
  })
  return { from }
}

/**
 * Every query resolves by table: select/eq chain to themselves, maybeSingle ends.
 * A table named in `errors` answers that error instead of its row.
 */
function makeTableStub(rows: Record<string, unknown>, errors: Record<string, unknown> = {}) {
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.eq = vi.fn(() => chain)
    chain.maybeSingle = vi.fn(async () =>
      table in errors ? { data: null, error: errors[table] } : { data: rows[table] ?? null, error: null },
    )
    return chain
  })
  return { from }
}

/** The canonical v1 envelope: a code, a docs link, and the request id echoed in the header. */
async function expectV1Envelope(res: Response, code: string) {
  const body = (await res.json()) as { error: Record<string, unknown> }
  expect(body.error).toMatchObject({
    code,
    message: expect.any(String),
    docs_url: expect.any(String),
    request_id: expect.stringMatching(/^req_/),
  })
  expect(res.headers.get('X-Request-Id')).toBe(body.error.request_id)
  return body.error
}

function makeRequest(companyId: string, init?: RequestInit, query = '') {
  return new Request(
    `https://x.test/api/v1/companies/${companyId}/salary-runs/${RUN_ID}/payslips/${EMPLOYEE_ID}/pdf${query}`,
    init,
  )
}

function makeParams(companyId: string, id: string = RUN_ID, employeeId: string = EMPLOYEE_ID) {
  return { params: Promise.resolve({ companyId, id, employeeId }) }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/v1/companies/[companyId]/salary-runs/[id]/payslips/[employeeId]/pdf', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await GET(makeRequest(COMPANY_A), makeParams(COMPANY_A))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('returns 404 and reads no payslip data when the key user is not a member of the URL company', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      apiKeyId: 'key-1',
      scopes: ['payroll:read'],
      mode: 'live',
    })
    const stub = makeSupabaseStub(null) // no membership in the URL company
    mockServiceClient.mockReturnValue(stub)

    const res = await GET(
      makeRequest(COMPANY_A, { headers: { Authorization: 'Bearer gnubok_sk_x' } }),
      makeParams(COMPANY_A),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
    // The deny fires in the wrapper: the handler's salary_runs /
    // salary_run_employees / companies queries must never have run.
    expect(stub.from.mock.calls.map((c) => c[0])).toEqual(['company_members'])
  })

  it('rejects non-UUID path ids with 400 before touching payroll tables', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      apiKeyId: 'key-1',
      scopes: ['payroll:read'],
      mode: 'live',
    })
    const stub = makeSupabaseStub({ company_id: COMPANY_A, role: 'owner' })
    mockServiceClient.mockReturnValue(stub)

    const res = await GET(
      makeRequest(COMPANY_A, { headers: { Authorization: 'Bearer gnubok_sk_x' } }),
      makeParams(COMPANY_A, 'not-a-uuid'),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(stub.from.mock.calls.map((c) => c[0])).toEqual(['company_members'])
  })

  it('rejects an unknown audience with 400 before touching payroll tables', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      apiKeyId: 'key-1',
      scopes: ['payroll:read'],
      mode: 'live',
    })
    const stub = makeSupabaseStub({ company_id: COMPANY_A, role: 'owner' })
    mockServiceClient.mockReturnValue(stub)

    const res = await GET(
      makeRequest(COMPANY_A, { headers: { Authorization: 'Bearer gnubok_sk_x' } }, '?audience=auditor'),
      makeParams(COMPANY_A),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(stub.from.mock.calls.map((c) => c[0])).toEqual(['company_members'])
  })

  describe('audience', () => {
    const rows = {
      company_members: { company_id: COMPANY_A, role: 'owner' },
      salary_runs: { id: RUN_ID, period_year: 2026, period_month: 6, payment_date: '2026-06-25' },
      salary_run_employees: { employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc' }, line_items: [] },
      companies: { name: 'Bolaget AB', org_number: '5560000000' },
      company_settings: { salary_payslip_show_employer_cost: false, salary_payslip_show_breakdown: true },
    }

    beforeEach(() => {
      mockValidate.mockResolvedValue({
        userId: 'user-1',
        apiKeyId: 'key-1',
        scopes: ['payroll:read'],
        mode: 'live',
      })
      vi.mocked(renderToBuffer).mockResolvedValue(Buffer.from('%PDF-fake'))
      vi.mocked(issuePayslipSections).mockResolvedValue({
        ok: true,
        snapshot: { payslip_sections_issued_at: null, payslip_show_employer_cost: null, payslip_show_breakdown: null },
      })
    })

    it('renders the employer view (every section) without an audience and never reads the switches', async () => {
      const stub = makeTableStub(rows)
      mockServiceClient.mockReturnValue(stub)

      const res = await GET(
        makeRequest(COMPANY_A, { headers: { Authorization: 'Bearer gnubok_sk_x' } }),
        makeParams(COMPANY_A),
      )

      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toBe('application/pdf')
      expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(
        expect.objectContaining({ audience: { kind: 'employer' } }),
      )
      expect(stub.from.mock.calls.map((c) => c[0])).not.toContain('company_settings')
      expect(vi.mocked(issuePayslipSections)).not.toHaveBeenCalled()
    })

    it('hands the payslip the run row with its tax table snapshot, not just the live employee (#3400)', async () => {
      const stub = makeTableStub({
        ...rows,
        salary_run_employees: {
          tax_table_number: 33,
          tax_column: 1,
          tax_table_year: 2026,
          employee: { first_name: 'Anna', last_name: 'A', personnummer: 'enc', tax_table_number: 34, tax_column: 1 },
          line_items: [],
        },
      })
      mockServiceClient.mockReturnValue(stub)

      const res = await GET(
        makeRequest(COMPANY_A, { headers: { Authorization: 'Bearer gnubok_sk_x' } }),
        makeParams(COMPANY_A),
      )

      expect(res.status).toBe(200)
      const sreIndex = stub.from.mock.calls.findIndex((c) => c[0] === 'salary_run_employees')
      const sreChain = stub.from.mock.results[sreIndex].value as { select: ReturnType<typeof vi.fn> }
      expect(String(sreChain.select.mock.calls[0][0])).toMatch(/^\*,/)
      expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(
        expect.objectContaining({
          sre: expect.objectContaining({ tax_table_number: 33, tax_column: 1, tax_table_year: 2026 }),
        }),
      )
    })

    function writerKey(extra: Record<string, unknown> = {}) {
      mockValidate.mockResolvedValue({
        userId: 'user-1',
        apiKeyId: 'key-1',
        scopes: ['payroll:read', 'payroll:write'],
        mode: 'live',
        ...extra,
      })
    }

    it('renders the employee copy with the company section switches for audience=employee', async () => {
      mockServiceClient.mockReturnValue(makeTableStub(rows))

      const res = await GET(
        makeRequest(COMPANY_A, { headers: { Authorization: 'Bearer gnubok_sk_x' } }, '?audience=employee'),
        makeParams(COMPANY_A),
      )

      expect(res.status).toBe(200)
      expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(
        expect.objectContaining({
          audience: {
            kind: 'employee',
            settings: { salary_payslip_show_employer_cost: false, salary_payslip_show_breakdown: true },
          },
        }),
      )
    })
    it('never issues the run for a payroll:read key: the copy follows the live switches', async () => {
      const stub = makeTableStub(rows)
      mockServiceClient.mockReturnValue(stub)

      const res = await GET(
        makeRequest(COMPANY_A, { headers: { Authorization: 'Bearer gnubok_sk_x' } }, '?audience=employee'),
        makeParams(COMPANY_A),
      )

      // A read must never cause a permanent write.
      expect(res.status).toBe(200)
      expect(vi.mocked(issuePayslipSections)).not.toHaveBeenCalled()
      expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(
        expect.objectContaining({
          run: rows.salary_runs,
          audience: { kind: 'employee', settings: rows.company_settings },
        }),
      )
    })

    it('renders a payroll:read key the sections an issued run was issued with, writing nothing', async () => {
      const issuedRun = {
        ...rows.salary_runs,
        status: 'booked',
        payslip_sections_issued_at: '2026-06-24T08:00:00.000Z',
        payslip_show_employer_cost: true,
        payslip_show_breakdown: true,
      }
      mockServiceClient.mockReturnValue(makeTableStub({ ...rows, salary_runs: issuedRun }))

      const res = await GET(
        makeRequest(COMPANY_A, { headers: { Authorization: 'Bearer gnubok_sk_x' } }, '?audience=employee'),
        makeParams(COMPANY_A),
      )

      expect(res.status).toBe(200)
      expect(vi.mocked(issuePayslipSections)).not.toHaveBeenCalled()
      // The stored snapshot travels on the run; payslipSectionsFor prints it
      // whatever the switches (both hidden-ish here) say now.
      expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(expect.objectContaining({ run: issuedRun }))
    })

    it('never issues the run for a viewer membership, even with payroll:write', async () => {
      writerKey()
      mockServiceClient.mockReturnValue(
        makeTableStub({ ...rows, company_members: { company_id: COMPANY_A, role: 'viewer' } }),
      )

      const res = await GET(
        makeRequest(COMPANY_A, { headers: { Authorization: 'Bearer gnubok_sk_x' } }, '?audience=employee'),
        makeParams(COMPANY_A),
      )

      expect(res.status).toBe(200)
      expect(vi.mocked(issuePayslipSections)).not.toHaveBeenCalled()
    })

    it('never issues the run over a read-only connection, even with payroll:write', async () => {
      writerKey({ allowedCompanyIds: [COMPANY_A], readOnlyCompanyIds: [COMPANY_A] })
      mockServiceClient.mockReturnValue(makeTableStub(rows))

      const res = await GET(
        makeRequest(COMPANY_A, { headers: { Authorization: 'Bearer gnubok_sk_x' } }, '?audience=employee'),
        makeParams(COMPANY_A),
      )

      expect(res.status).toBe(200)
      expect(vi.mocked(issuePayslipSections)).not.toHaveBeenCalled()
    })

    it('never issues the run for a test-mode key (simulation only)', async () => {
      writerKey({ mode: 'test' })
      mockServiceClient.mockReturnValue(makeTableStub(rows))

      const res = await GET(
        makeRequest(COMPANY_A, { headers: { Authorization: 'Bearer gnubok_sk_x' } }, '?audience=employee'),
        makeParams(COMPANY_A),
      )

      expect(res.status).toBe(200)
      expect(vi.mocked(issuePayslipSections)).not.toHaveBeenCalled()
    })

    it('issues the run for a payroll:write key and renders what was issued', async () => {
      writerKey()
      const stub = makeTableStub(rows)
      mockServiceClient.mockReturnValue(stub)
      const issuedShown = {
        payslip_sections_issued_at: '2026-06-24T08:00:00.000Z',
        payslip_show_employer_cost: true,
        payslip_show_breakdown: true,
      }
      vi.mocked(issuePayslipSections).mockResolvedValue({ ok: true, snapshot: issuedShown })

      const res = await GET(
        makeRequest(COMPANY_A, { headers: { Authorization: 'Bearer gnubok_sk_x' } }, '?audience=employee'),
        makeParams(COMPANY_A),
      )

      expect(res.status).toBe(200)
      expect(vi.mocked(issuePayslipSections)).toHaveBeenCalledWith(stub, {
        companyId: COMPANY_A,
        run: rows.salary_runs,
        settings: rows.company_settings,
      })
      expect(vi.mocked(buildPayslipData)).toHaveBeenCalledWith(
        expect.objectContaining({ run: { ...rows.salary_runs, ...issuedShown } }),
      )
    })

    it('answers an error and renders nothing when the issued sections cannot be fixed', async () => {
      writerKey()
      mockServiceClient.mockReturnValue(makeTableStub(rows))
      vi.mocked(issuePayslipSections).mockResolvedValue({ ok: false, error: { message: 'timeout' } })

      const res = await GET(
        makeRequest(COMPANY_A, { headers: { Authorization: 'Bearer gnubok_sk_x' } }, '?audience=employee'),
        makeParams(COMPANY_A),
      )

      expect(res.status).toBe(500)
      await expectV1Envelope(res, 'INTERNAL_ERROR')
      expect(vi.mocked(buildPayslipData)).not.toHaveBeenCalled()
    })

    it('answers the canonical envelope and renders nothing when the section switches cannot be read', async () => {
      writerKey()
      mockServiceClient.mockReturnValue(makeTableStub(rows, { company_settings: { message: 'timeout' } }))

      const res = await GET(
        makeRequest(COMPANY_A, { headers: { Authorization: 'Bearer gnubok_sk_x' } }, '?audience=employee'),
        makeParams(COMPANY_A),
      )

      // Fail closed: no fallback to the default switches.
      expect(res.status).toBe(500)
      await expectV1Envelope(res, 'INTERNAL_ERROR')
      expect(vi.mocked(issuePayslipSections)).not.toHaveBeenCalled()
      expect(vi.mocked(buildPayslipData)).not.toHaveBeenCalled()
    })
  })
})
