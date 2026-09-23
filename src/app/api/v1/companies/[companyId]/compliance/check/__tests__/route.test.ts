/**
 * Integration tests for GET /api/v1/companies/:companyId/compliance/check.
 *
 * Focus: the voucher_gaps runner must check EVERY voucher series registered
 * for the period (BFNAR 2013:2 kap 8 §: the verifikationsnummerserie must be
 * unbroken per series, and a gap must be documented). Checking only series
 * 'A' reports "clean" books that are not clean.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as complianceCheck } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PERIOD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

type MockResult = { data?: unknown; error?: unknown }
type Gap = { gap_start: number; gap_end: number }

/** Per-table result queues + a `detect_voucher_gaps` stub keyed by p_series. */
function makeSupabase(opts: {
  tables?: Record<string, MockResult>
  gapsBySeries?: Record<string, Gap[]>
  rpcError?: unknown
}) {
  const tables = opts.tables ?? {}
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve(tables[table] ?? { data: null, error: null })
        }
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }
  const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => {
    if (opts.rpcError) return { data: null, error: opts.rpcError }
    const series = args.p_series as string
    return { data: opts.gapsBySeries?.[series] ?? [], error: null }
  })
  return { from: vi.fn((table: string) => buildChain(table)), rpc }
}

const MEMBERSHIP: MockResult = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const PERIOD: MockResult = { data: { id: PERIOD_ID }, error: null }

function makeRequest(query: string, opts: { auth?: boolean } = {}): Request {
  return new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/compliance/check${query}`, {
    method: 'GET',
    headers: opts.auth === false ? {} : { Authorization: 'Bearer test-fixture-not-a-real-key' },
  })
}

function call(request: Request) {
  return complianceCheck(request, { params: Promise.resolve({ companyId: COMPANY_ID }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['compliance:read'],
    mode: 'live',
  })
})

describe('GET /api/v1/companies/:companyId/compliance/check', () => {
  it('returns 401 without a bearer token', async () => {
    mockServiceClient.mockReturnValue(makeSupabase({}))
    const res = await call(makeRequest(`?type=voucher_gaps&fiscal_period_id=${PERIOD_ID}`, { auth: false }))
    expect(res.status).toBe(401)
  })

  it('returns 400 for an unsupported check type', async () => {
    mockServiceClient.mockReturnValue(makeSupabase({ tables: { company_members: MEMBERSHIP } }))
    const res = await call(makeRequest('?type=not_a_check'))
    expect(res.status).toBe(400)
  })

  it('returns 400 when voucher_gaps is called without fiscal_period_id', async () => {
    mockServiceClient.mockReturnValue(makeSupabase({ tables: { company_members: MEMBERSHIP } }))
    const res = await call(makeRequest('?type=voucher_gaps'))
    expect(res.status).toBe(400)
  })

  it('returns 404 when the caller is not a member of the company', async () => {
    mockServiceClient.mockReturnValue(
      makeSupabase({ tables: { company_members: { data: null, error: null } } }),
    )
    const res = await call(makeRequest(`?type=voucher_gaps&fiscal_period_id=${PERIOD_ID}`))
    expect(res.status).toBe(404)
  })

  it('reports clean when every series is continuous', async () => {
    mockServiceClient.mockReturnValue(
      makeSupabase({
        tables: {
          company_members: MEMBERSHIP,
          fiscal_periods: PERIOD,
          voucher_sequences: { data: [{ voucher_series: 'A' }, { voucher_series: 'F' }], error: null },
        },
        gapsBySeries: {},
      }),
    )
    const res = await call(makeRequest(`?type=voucher_gaps&fiscal_period_id=${PERIOD_ID}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.ready).toBe(true)
    expect(body.data.findings).toHaveLength(0)
    expect(body.data.details.total_gaps).toBe(0)
    expect(body.data.details.series_checked).toEqual(['A', 'F'])
  })

  it('reports a gap that sits in a non-A series (series F: 33 → 37)', async () => {
    const supabase = makeSupabase({
      tables: {
        company_members: MEMBERSHIP,
        fiscal_periods: PERIOD,
        voucher_sequences: { data: [{ voucher_series: 'A' }, { voucher_series: 'F' }], error: null },
        voucher_gap_explanations: { data: [], error: null },
      },
      gapsBySeries: { F: [{ gap_start: 34, gap_end: 36 }] },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await call(makeRequest(`?type=voucher_gaps&fiscal_period_id=${PERIOD_ID}`))
    expect(res.status).toBe(200)
    const body = await res.json()

    // Every registered series is checked, not only the RPC's 'A' default.
    const seriesArgs = supabase.rpc.mock.calls.map((c) => (c[1] as { p_series: string }).p_series)
    expect(seriesArgs).toEqual(['A', 'F'])

    expect(body.data.ready).toBe(false)
    expect(body.data.findings).toHaveLength(1)
    const finding = body.data.findings[0]
    expect(finding.severity).toBe('blocker')
    expect(finding.code).toBe('VOUCHER_GAP_UNEXPLAINED')
    // The RPC returns only (gap_start, gap_end): the series must still be real.
    expect(finding.message).toContain('Series F')
    expect(finding.message).not.toContain('undefined')
    expect(finding.details).toMatchObject({
      voucher_series: 'F',
      gap_start: 34,
      gap_end: 36,
      has_explanation: false,
    })
    expect(body.data.details.unexplained_count).toBe(1)
  })

  it('downgrades a gap to info only when voucher_gap_explanations documents it', async () => {
    mockServiceClient.mockReturnValue(
      makeSupabase({
        tables: {
          company_members: MEMBERSHIP,
          fiscal_periods: PERIOD,
          voucher_sequences: { data: [{ voucher_series: 'F' }], error: null },
          voucher_gap_explanations: {
            data: [{ voucher_series: 'F', gap_start: 34, gap_end: 36 }],
            error: null,
          },
        },
        gapsBySeries: { F: [{ gap_start: 34, gap_end: 36 }] },
      }),
    )
    const res = await call(makeRequest(`?type=voucher_gaps&fiscal_period_id=${PERIOD_ID}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.ready).toBe(true)
    expect(body.data.findings[0].severity).toBe('info')
    expect(body.data.findings[0].code).toBe('VOUCHER_GAP_EXPLAINED')
    expect(body.data.findings[0].details.voucher_series).toBe('F')
  })

  it('falls back to series A when the period has no voucher_sequences rows', async () => {
    const supabase = makeSupabase({
      tables: {
        company_members: MEMBERSHIP,
        fiscal_periods: PERIOD,
        voucher_sequences: { data: [], error: null },
      },
      gapsBySeries: {},
    })
    mockServiceClient.mockReturnValue(supabase)
    const res = await call(makeRequest(`?type=voucher_gaps&fiscal_period_id=${PERIOD_ID}`))
    expect(res.status).toBe(200)
    expect(supabase.rpc.mock.calls.map((c) => (c[1] as { p_series: string }).p_series)).toEqual(['A'])
  })

  it('surfaces a failing detection instead of reporting "no gaps"', async () => {
    mockServiceClient.mockReturnValue(
      makeSupabase({
        tables: {
          company_members: MEMBERSHIP,
          fiscal_periods: PERIOD,
          voucher_sequences: { data: [{ voucher_series: 'F' }], error: null },
        },
        rpcError: { message: 'boom', code: 'XX000' },
      }),
    )
    const res = await call(makeRequest(`?type=voucher_gaps&fiscal_period_id=${PERIOD_ID}`))
    expect(res.status).toBeGreaterThanOrEqual(400)
    const body = await res.json()
    expect(body.data).toBeUndefined()
  })

  it('returns 400 when fiscal_period_id belongs to another company', async () => {
    mockServiceClient.mockReturnValue(
      makeSupabase({
        tables: { company_members: MEMBERSHIP, fiscal_periods: { data: null, error: null } },
      }),
    )
    const res = await call(makeRequest(`?type=voucher_gaps&fiscal_period_id=${PERIOD_ID}`))
    expect(res.status).toBe(400)
  })
})
