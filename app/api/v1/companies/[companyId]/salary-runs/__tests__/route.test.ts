/**
 * Integration tests for the v1 salary-runs CRUD (Phase 5 PR-1).
 *
 * Covers list / detail / create / patch / delete on /salary-runs. The lifecycle
 * verbs (:calculate / :approve / :mark-paid / :book / :generate-agi) ship in
 * Phase 5 PR-2.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `salary-runs route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
    )
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as listSalaryRuns, POST as createSalaryRun } from '../route'
import {
  GET as getSalaryRun,
  PATCH as updateSalaryRun,
  DELETE as deleteSalaryRun,
} from '../[id]/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
  count?: number | null
}

function makeFlexibleSupabase(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(table)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
            resolve(next)
          }
        }
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const USER_ID = 'user-1'

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': 'b1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ...(init?.headers ?? {}),
    },
  })
}

function companyParams(companyId: string) {
  return { params: Promise.resolve({ companyId }) }
}

function detailParams(companyId: string, id: string) {
  return { params: Promise.resolve({ companyId, id }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['payroll:read', 'payroll:write'],
    mode: 'live',
  })
})

const SAMPLE_RUN = {
  id: RUN_ID,
  period_year: 2026,
  period_month: 5,
  payment_date: '2026-05-25',
  status: 'draft',
  voucher_series: 'L',
  total_gross: 0,
  total_tax: 0,
  total_net: 0,
  total_avgifter: 0,
  total_vacation_accrual: 0,
  total_employer_cost: 0,
  salary_entry_id: null,
  avgifter_entry_id: null,
  vacation_entry_id: null,
  agi_generated_at: null,
  agi_submitted_at: null,
  calculation_params: null,
  approved_by: null,
  approved_at: null,
  paid_at: null,
  booked_at: null,
  booked_by: null,
  notes: null,
  created_at: '2026-05-01T08:00:00Z',
  updated_at: '2026-05-01T08:00:00Z',
}

describe('GET /api/v1/companies/:companyId/salary-runs', () => {
  it('returns paginated salary runs', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: [SAMPLE_RUN], error: null },
      }),
    )

    const res = await listSalaryRuns(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].period_year).toBe(2026)
    expect(body.data[0].status).toBe('draft')
  })

  it('rejects an out-of-range period_year filter', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await listSalaryRuns(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs?period_year=1999`),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(400)
  })

  it('rejects keys without payroll:read scope', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      apiKeyName: 'wrong scope',
      scopes: ['invoices:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await listSalaryRuns(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs`),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(403)
  })
})

describe('GET /api/v1/companies/:companyId/salary-runs/:id', () => {
  it('returns the salary run', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: SAMPLE_RUN, error: null },
      }),
    )

    const res = await getSalaryRun(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}`),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.id).toBe(RUN_ID)
  })

  it('returns 404 SALARY_RUN_NOT_FOUND when missing', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: null, error: null },
      }),
    )

    const res = await getSalaryRun(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}`),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_NOT_FOUND')
  })
})

describe('POST /api/v1/companies/:companyId/salary-runs', () => {
  const validBody = {
    period_year: 2026,
    period_month: 5,
    payment_date: '2026-05-25',
    voucher_series: 'L',
  }

  it('creates a salary run and emits salary_run.created (happy path)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: SAMPLE_RUN, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await createSalaryRun(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs`, {
        method: 'POST',
        body: JSON.stringify(validBody),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.id).toBe(RUN_ID)
    expect(body.data.status).toBe('draft')
  })

  it('returns 409 SALARY_RUN_DUPLICATE_PERIOD on unique-constraint violation', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: {
          data: null,
          error: {
            code: '23505',
            message: 'duplicate',
            // The inline `UNIQUE (company_id, period_year, period_month)`
            // constraint is auto-named `<table>_<columns>_key`. The route
            // disambiguates 23505s by substring-matching on the columns.
            constraint: 'salary_runs_company_id_period_year_period_month_key',
          },
        },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await createSalaryRun(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs`, {
        method: 'POST',
        body: JSON.stringify(validBody),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_DUPLICATE_PERIOD')
  })

  it('returns 400 for period_month out of range', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await createSalaryRun(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs`, {
        method: 'POST',
        body: JSON.stringify({ ...validBody, period_month: 13 }),
      }),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(400)
  })

  it('returns 400 when Idempotency-Key is missing', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const req = new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test' },
      body: JSON.stringify(validBody),
    })

    const res = await createSalaryRun(req, companyParams(COMPANY_ID))
    expect(res.status).toBe(400)
  })

  it('returns a dry-run preview without committing when ?dry_run=true', async () => {
    const fromSpy = vi.fn()
    mockServiceClient.mockReturnValue({
      from: (table: string) => {
        fromSpy(table)
        return new Proxy({}, {
          get(_t, prop) {
            if (prop === 'then') {
              const data = table === 'company_members'
                ? { company_id: COMPANY_ID, role: 'owner' }
                : null
              return (resolve: (v: unknown) => void) => resolve({ data, error: null })
            }
            return () => new Proxy({}, this!)
          },
        })
      },
    })

    const res = await createSalaryRun(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs?dry_run=true`, {
        method: 'POST',
        body: JSON.stringify(validBody),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    expect(fromSpy).not.toHaveBeenCalledWith('salary_runs')
  })
})

describe('PATCH /api/v1/companies/:companyId/salary-runs/:id', () => {
  it('updates a draft salary run and clears roster calculation_breakdown', async () => {
    const updated = { ...SAMPLE_RUN, payment_date: '2026-05-23' }
    const flex = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      salary_runs: [{ data: SAMPLE_RUN, error: null }, { data: updated, error: null }],
      salary_run_employees: { data: null, error: null },
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(flex)

    const res = await updateSalaryRun(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ payment_date: '2026-05-23' }),
      }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.payment_date).toBe('2026-05-23')
    // A supplied payment_date invalidates any existing calculation so the
    // book preflights force a recalculation against the new date.
    expect(flex.from).toHaveBeenCalledWith('salary_run_employees')
  })

  it('returns 400 SALARY_RUN_PAYMENT_DATE_OUTSIDE_PERIOD for a cross-month payment_date', async () => {
    // Period 2026-05: moving the payment into June would book the verifikat
    // in June while the AGI still declares 202605 (kontantprincipen).
    const flex = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      salary_runs: { data: SAMPLE_RUN, error: null },
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(flex)

    const res = await updateSalaryRun(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ payment_date: '2026-06-05' }),
      }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_PAYMENT_DATE_OUTSIDE_PERIOD')
    expect(flex.from).not.toHaveBeenCalledWith('salary_run_employees')
  })

  it('grandfathers day adjustments when the current date is already outside the period', async () => {
    // Creation does not enforce the period coupling, so a legally created
    // out-of-period date must stay correctable within its own month.
    const grandfathered = { ...SAMPLE_RUN, payment_date: '2026-06-05' }
    const updated = { ...SAMPLE_RUN, payment_date: '2026-06-07' }
    const flex = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      salary_runs: [{ data: grandfathered, error: null }, { data: updated, error: null }],
      salary_run_employees: { data: null, error: null },
      idempotency_keys: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(flex)

    const res = await updateSalaryRun(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ payment_date: '2026-06-07' }),
      }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.payment_date).toBe('2026-06-07')
  })

  it('returns 400 SALARY_RUN_PATCH_NOT_DRAFT for non-draft status', async () => {
    const approved = { ...SAMPLE_RUN, status: 'approved' }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: approved, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await updateSalaryRun(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ payment_date: '2026-05-23' }),
      }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_PATCH_NOT_DRAFT')
    expect(body.error.details.current_status).toBe('approved')
  })

  it('returns 404 SALARY_RUN_NOT_FOUND when row missing', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: null, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await updateSalaryRun(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ payment_date: '2026-05-23' }),
      }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(404)
  })

  it('rejects voucher_series that is not a single A-Z letter', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: SAMPLE_RUN, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await updateSalaryRun(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ voucher_series: 'AB' }),
      }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/v1/companies/:companyId/salary-runs/:id', () => {
  it('deletes a draft salary run', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: [
          // First read: existing row check
          { data: { id: RUN_ID, status: 'draft' }, error: null },
          // Second op: the DELETE call
          { error: null, count: 1 },
        ],
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await deleteSalaryRun(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}`, {
        method: 'DELETE',
      }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(204)
  })

  it('refuses to delete a non-draft salary run (BFL 5 kap immutability)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: { id: RUN_ID, status: 'booked' }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await deleteSalaryRun(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}`, {
        method: 'DELETE',
      }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_DELETE_NOT_DRAFT')
    expect(body.error.details.current_status).toBe('booked')
  })

  it('returns 404 SALARY_RUN_NOT_FOUND for unknown ids', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: { data: null, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await deleteSalaryRun(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}`, {
        method: 'DELETE',
      }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(404)
  })

  it('refuses to delete a draft that already has journal-entry foreign keys set (BFL 5 kap)', async () => {
    // Defense in depth: if a hypothetical partial failure ever left a row
    // in status=draft with non-null salary_entry_id, the DELETE must NOT
    // orphan the verifikation. The route's .is('salary_entry_id', null)
    // filter trips, count comes back 0, and we surface the race-style
    // 400 SALARY_RUN_DELETE_NOT_DRAFT.
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        salary_runs: [
          // First read: row is status=draft (passes the pre-flight)
          { data: { id: RUN_ID, status: 'draft' }, error: null },
          // DELETE: the FK-null guards trip, count=0
          { error: null, count: 0 },
        ],
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await deleteSalaryRun(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}`, {
        method: 'DELETE',
      }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    // Phase 5 PR-2 swapped this to a distinct BFL 5 kap code so an
    // operator seeing this in logs immediately knows a verifikation may
    // be attached, not just that the status raced.
    expect(body.error.code).toBe('SALARY_RUN_DELETE_HAS_JOURNAL_ENTRY')
    expect(body.error.details.reason).toBe('fk_non_null_or_status_race')
  })
})
