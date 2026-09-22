/**
 * Tests for POST /api/v1/companies/{companyId}/salary-runs/{id}/correct
 * (rättelsekörning). The shared core (lib/salary/correct-run.ts) is stubbed
 * so these exercise the route contract: auth/scope, the mandatory
 * Idempotency-Key, id validation, the result-to-envelope mapping, the
 * response shape and the dry-run pass-through.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CannotReverseNonPostedError } from '@/lib/bookkeeping/errors'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `salary-run correct tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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

const mocks = vi.hoisted(() => ({
  correctSalaryRun: vi.fn(),
}))

vi.mock('@/lib/salary/correct-run', () => ({
  correctSalaryRun: mocks.correctSalaryRun,
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as correct } from '../route'

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
  return {
    from: vi.fn((table: string) => buildChain(table)),
  }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CORRECTION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const JE_SALARY = '11111111-1111-4111-8111-111111111111'
const JE_AVG = '22222222-2222-4222-8222-222222222222'
const USER_ID = 'user-1'
const URL = `https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/${RUN_ID}/correct`

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

function detailParams(companyId: string, id: string) {
  return { params: Promise.resolve({ companyId, id }) }
}

function memberSupabase() {
  return makeFlexibleSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    idempotency_keys: { data: null, error: null },
  })
}

const LIVE_OK = {
  ok: true,
  dryRun: false,
  originalRunId: RUN_ID,
  correctionRun: {
    id: CORRECTION_ID,
    company_id: COMPANY_ID,
    status: 'draft',
    period_year: 2026,
    period_month: 5,
    payment_date: '2026-05-25',
    voucher_series: 'L',
    deviation_period_start: '2026-04-01',
    deviation_period_end: '2026-04-30',
    is_correction: true,
    corrects_run_id: RUN_ID,
    notes: 'Korrigering av lönekörning 2026-05',
  },
  reversedEntryIds: [JE_SALARY, JE_AVG],
  stampedAt: '2026-06-03T09:15:00.000Z',
  warnings: [],
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
  mockServiceClient.mockReturnValue(memberSupabase())
})

describe('POST /salary-runs/:id/correct', () => {
  it('returns 401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })

    const res = await correct(makeRequest(URL, { method: 'POST' }), detailParams(COMPANY_ID, RUN_ID))

    expect(res.status).toBe(401)
    expect(mocks.correctSalaryRun).not.toHaveBeenCalled()
  })

  it('returns 403 INSUFFICIENT_SCOPE without payroll:write', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      apiKeyName: 'CI key',
      scopes: ['payroll:read'],
      mode: 'live',
    })

    const res = await correct(makeRequest(URL, { method: 'POST' }), detailParams(COMPANY_ID, RUN_ID))

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(mocks.correctSalaryRun).not.toHaveBeenCalled()
  })

  it('returns 400 VALIDATION_ERROR when Idempotency-Key is missing', async () => {
    const res = await correct(
      new Request(URL, { method: 'POST', headers: { Authorization: 'Bearer test-fixture-not-a-real-key' } }),
      detailParams(COMPANY_ID, RUN_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.issues[0].field).toBe('Idempotency-Key')
    expect(mocks.correctSalaryRun).not.toHaveBeenCalled()
  })

  it('returns 400 VALIDATION_ERROR for a non-UUID run id', async () => {
    const res = await correct(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary-runs/not-a-uuid/correct`, {
        method: 'POST',
      }),
      detailParams(COMPANY_ID, 'not-a-uuid'),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('id')
    expect(mocks.correctSalaryRun).not.toHaveBeenCalled()
  })

  it('returns 404 SALARY_RUN_NOT_FOUND', async () => {
    mocks.correctSalaryRun.mockResolvedValue({ ok: false, code: 'SALARY_RUN_NOT_FOUND' })

    const res = await correct(makeRequest(URL, { method: 'POST' }), detailParams(COMPANY_ID, RUN_ID))

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_NOT_FOUND')
  })

  it('returns 409 SALARY_RUN_CORRECT_NOT_BOOKED with the current status', async () => {
    mocks.correctSalaryRun.mockResolvedValue({
      ok: false,
      code: 'SALARY_RUN_CORRECT_NOT_BOOKED',
      details: { current_status: 'paid' },
    })

    const res = await correct(makeRequest(URL, { method: 'POST' }), detailParams(COMPANY_ID, RUN_ID))

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_CORRECT_NOT_BOOKED')
    expect(body.error.details.current_status).toBe('paid')
  })

  it('returns 409 SALARY_RUN_ALREADY_CORRECTED pointing at the correction run', async () => {
    mocks.correctSalaryRun.mockResolvedValue({
      ok: false,
      code: 'SALARY_RUN_ALREADY_CORRECTED',
      details: { current_status: 'corrected', correction_run_id: CORRECTION_ID, reason: 'status_corrected' },
    })

    const res = await correct(makeRequest(URL, { method: 'POST' }), detailParams(COMPANY_ID, RUN_ID))

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('SALARY_RUN_ALREADY_CORRECTED')
    expect(body.error.details.correction_run_id).toBe(CORRECTION_ID)
  })

  it('maps a storno failure through the bookkeeping error envelope with the partial-state details', async () => {
    mocks.correctSalaryRun.mockResolvedValue({
      ok: false,
      code: 'REVERSAL_FAILED',
      error: new CannotReverseNonPostedError('reversed'),
      details: { entry_id: JE_AVG, reversed_entry_ids: [JE_SALARY], remaining_entry_ids: [] },
    })

    const res = await correct(makeRequest(URL, { method: 'POST' }), detailParams(COMPANY_ID, RUN_ID))

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('CANNOT_REVERSE_NON_POSTED')
    // The bookkeeping error keeps its canonical details; the partial state is
    // the agent's next step and rides valid_alternatives.
    expect(body.error.details).toEqual({ currentStatus: 'reversed' })
    expect(body.error.valid_alternatives).toEqual({
      salary_run_id: RUN_ID,
      failed_entry_id: JE_AVG,
      reversed_entry_ids: [JE_SALARY],
      remaining_entry_ids: [],
      reverse_endpoint: `/api/v1/companies/${COMPANY_ID}/journal-entries/{id}/reverse`,
    })
  })

  it('corrects a booked run and returns the original, the correction draft and the reversed entries', async () => {
    mocks.correctSalaryRun.mockResolvedValue(LIVE_OK)

    const res = await correct(makeRequest(URL, { method: 'POST' }), detailParams(COMPANY_ID, RUN_ID))

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBeNull()
    const body = await res.json()
    expect(body.data).toEqual({
      original_run_id: RUN_ID,
      original_status: 'corrected',
      correction_run: {
        id: CORRECTION_ID,
        period_year: 2026,
        period_month: 5,
        payment_date: '2026-05-25',
        status: 'draft',
        is_correction: true,
        corrects_run_id: RUN_ID,
        deviation_period_start: '2026-04-01',
        deviation_period_end: '2026-04-30',
      },
      reversed_entry_ids: [JE_SALARY, JE_AVG],
    })
    expect(body.meta.audit.immutable_at).toBe('2026-06-03T09:15:00.000Z')
    expect(mocks.correctSalaryRun).toHaveBeenCalledOnce()
    const [, args] = mocks.correctSalaryRun.mock.calls[0]
    expect(args).toEqual({ companyId: COMPANY_ID, userId: USER_ID, runId: RUN_ID, dryRun: false })
  })

  it('passes dry_run through to the core and returns the preview with X-Dry-Run', async () => {
    mocks.correctSalaryRun.mockResolvedValue({
      ok: true,
      dryRun: true,
      preview: {
        original_run: {
          id: RUN_ID,
          status: 'booked',
          period_year: 2026,
          period_month: 5,
          payment_date: '2026-05-25',
          voucher_series: 'L',
          deviation_period_start: null,
          deviation_period_end: null,
        },
        entries_to_reverse: [JE_SALARY, JE_AVG],
        correction_run: {
          period_year: 2026,
          period_month: 5,
          payment_date: '2026-05-25',
          voucher_series: 'L',
          deviation_period_start: null,
          deviation_period_end: null,
          status: 'draft',
          is_correction: true,
          corrects_run_id: RUN_ID,
        },
      },
    })

    const res = await correct(makeRequest(`${URL}?dry_run=true`, { method: 'POST' }), detailParams(COMPANY_ID, RUN_ID))

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({
      id: RUN_ID,
      would_advance_status_from: 'booked',
      would_advance_status_to: 'corrected',
      would_reverse_entry_ids: [JE_SALARY, JE_AVG],
      would_create_correction_run: { status: 'draft', is_correction: true, corrects_run_id: RUN_ID },
    })
    const [, args] = mocks.correctSalaryRun.mock.calls[0]
    expect(args.dryRun).toBe(true)
  })
})
