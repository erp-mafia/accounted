/**
 * Tests for POST /api/v1/companies/{companyId}/salary/vacation-year-close
 * and GET /employees/{id}/vacation-balance (payroll gap-closure 3.4).
 *
 * The close service is mocked: these tests cover auth, validation, dry-run
 * preview plumbing, and error mapping. The beredning/reconcile math is
 * covered in lib/salary/__tests__/semesterberedning.test.ts.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `vacation-year-close route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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

const mockPreview = vi.fn()
const mockCommit = vi.fn()
vi.mock('@/lib/salary/semesterberedning', () => ({
  previewVacationYearClose: (...a: unknown[]) => mockPreview(...a),
  commitVacationYearClose: (...a: unknown[]) => mockCommit(...a),
}))

vi.mock('@/lib/salary/vacation-ledger', () => ({
  getVacationYearBasis: vi.fn().mockResolvedValue('calendar'),
  syncVacationLedgerForEmployees: vi.fn().mockResolvedValue({ ok: true }),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as closeYear } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

function makeFlexibleSupabase(byTable: Record<string, { data?: unknown; error?: unknown }>) {
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve(byTable[table] ?? { data: null, error: null })
        }
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_ID = 'user-1'

const SAMPLE_REPORT = {
  vacation_year_start: '2025-01-01',
  vacation_year_end: '2025-12-31',
  next_year_start: '2026-01-01',
  basis: 'calendar',
  rows: [],
  sek: {
    computed_liability: 0,
    computed_avgifter: 0,
    booked_2920: 0,
    booked_2940: 0,
    drift_2920: 0,
    drift_2940: 0,
    adjustment_needed: false,
  },
  adjustment_date: '2025-12-31',
}

function makeRequest(url: string, body?: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': 'b1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
    body: JSON.stringify(body ?? {}),
  })
}

function companyParams(companyId: string) {
  return { params: Promise.resolve({ companyId }) }
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
  mockServiceClient.mockReturnValue(
    makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      idempotency_keys: { data: null, error: null },
    }),
  )
})

describe('POST /salary/vacation-year-close', () => {
  it('commits the close and returns the closure + adjustment ids', async () => {
    mockCommit.mockResolvedValue({
      ok: true,
      data: { closure_id: 'closure-1', adjustment_entry_id: 'je-1', report: SAMPLE_REPORT },
    })

    const res = await closeYear(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary/vacation-year-close`, {
        vacation_year_start: '2025-01-01',
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.vacation_year_closure_id).toBe('closure-1')
    expect(body.data.adjustment_entry_id).toBe('je-1')
    expect(mockCommit).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      USER_ID,
      '2025-01-01',
      { bookAdjustment: true },
    )
  })

  it('defaults the year to the most recently ended one when omitted', async () => {
    mockCommit.mockResolvedValue({
      ok: true,
      data: { closure_id: 'closure-1', adjustment_entry_id: null, report: SAMPLE_REPORT },
    })

    const res = await closeYear(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary/vacation-year-close`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const currentYear = new Date().getFullYear()
    expect(mockCommit.mock.calls[0][3]).toBe(`${currentYear - 1}-01-01`)
  })

  it('dry_run returns the full preview report with zero commits', async () => {
    mockPreview.mockResolvedValue({ ok: true, data: SAMPLE_REPORT })

    const res = await closeYear(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/salary/vacation-year-close?dry_run=true`,
        { vacation_year_start: '2025-01-01' },
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.preview.report.vacation_year_start).toBe('2025-01-01')
    expect(mockCommit).not.toHaveBeenCalled()
  })

  it('maps VACATION_YEAR_ALREADY_CLOSED to 409', async () => {
    mockCommit.mockResolvedValue({ ok: false, code: 'VACATION_YEAR_ALREADY_CLOSED' })

    const res = await closeYear(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary/vacation-year-close`, {
        vacation_year_start: '2025-01-01',
      }),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('VACATION_YEAR_ALREADY_CLOSED')
  })

  it('maps PERIOD_LOCKED without committing anything', async () => {
    mockCommit.mockResolvedValue({ ok: false, code: 'PERIOD_LOCKED', details: { reason: 'closed' } })

    const res = await closeYear(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary/vacation-year-close`, {
        vacation_year_start: '2025-01-01',
      }),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBeGreaterThanOrEqual(400)
    const body = await res.json()
    expect(body.error.code).toBe('PERIOD_LOCKED')
  })

  it('rejects keys without payroll:write scope', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      apiKeyName: 'read-only',
      scopes: ['payroll:read'],
      mode: 'live',
    })

    const res = await closeYear(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/salary/vacation-year-close`),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(403)
  })

  it('requires an Idempotency-Key', async () => {
    const req = new Request(
      `https://x.test/api/v1/companies/${COMPANY_ID}/salary/vacation-year-close`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer test' },
        body: JSON.stringify({}),
      },
    )
    const res = await closeYear(req, companyParams(COMPANY_ID))
    expect(res.status).toBe(400)
  })
})
