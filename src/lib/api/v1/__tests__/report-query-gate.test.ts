/**
 * The report query gate in withApiV1 (default mode).
 *
 * Before it, only four report routes opted in to assertKnownQueryParams, so
 * ?dim_no=6&dim_code=P001 on the trial balance, the general ledger or any
 * filing report answered the unfiltered report to a caller who believed it
 * filtered ("a filter must never be silently ignored",
 * lib/reports/dimension-filter.ts). The gate covers every GET on a
 * reports.* or arsredovisning.* operation, hand-written, operation door and
 * file door alike, against the query each endpoint registers:
 *   - a dimension filter the report does not register is refused (400);
 *   - any other unregistered parameter is served and named in the
 *     X-Ignored-Query-Params header, because production integrations may
 *     send parameters nobody can see and a new 400 would break them.
 * STRICT_REPORT_QUERY_PARAMS refuses every unregistered parameter; that mode
 * is pinned in report-query-gate-strict.test.ts.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

beforeAll(() => {
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
// The lease sits after the gate; a refused request must never take it.
const externalReportGuard = vi.hoisted(() => vi.fn())
vi.mock('@/lib/import/sie-period-read', () => ({ withSIEExternalReport: externalReportGuard }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { listEndpoints, registerEndpoint, dataEnvelope, type EndpointDefinition } from '../registry'
import {
  DIMENSION_FILTER_QUERY_PARAMS,
  STRICT_REPORT_QUERY_PARAMS,
  isReportRead,
  registeredQueryParams,
  reportQueryVerdict,
} from '../report-period'
import { withApiV1, type ApiV1Context } from '../with-api-v1'
import { ok } from '../response'
import { v1ErrorResponseFromCode } from '../errors'
// Side-effect import: populates the ENDPOINTS registry from every route file.
import '../load-routes'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RESOURCE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** company_members answers `membership`; every other read answers nothing. */
function makeSupabase(membership: { company_id: string; role: string } | null) {
  const build = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
          if (prop === 'maybeSingle' || prop === 'single') {
            return () => Promise.resolve({ data: table === 'company_members' ? membership : null, error: null })
          }
          return () => build(table)
        },
      },
    )
  return { from: vi.fn((table: string) => build(table)), rpc: vi.fn(() => build('rpc')) }
}

beforeEach(() => {
  vi.clearAllMocks()
  externalReportGuard.mockImplementation((_s: unknown, _c: unknown, _op: unknown, read: () => unknown) => read())
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['reports:read'],
    mode: 'live',
  })
  mockServiceClient.mockReturnValue(makeSupabase({ company_id: COMPANY_ID, role: 'owner' }))
})

describe('gate helpers', () => {
  it('ships non-strict: stray parameters are reported, not refused', () => {
    expect(STRICT_REPORT_QUERY_PARAMS).toBe(false)
  })

  it('scopes the gate to GET on report operations', () => {
    expect(isReportRead('GET', 'reports.trial-balance')).toBe(true)
    expect(isReportRead('GET', 'reports.ink2.sru')).toBe(true)
    expect(isReportRead('GET', 'arsredovisning.pdf')).toBe(true)
    expect(isReportRead('POST', 'reports.vat-declaration')).toBe(false)
    expect(isReportRead('GET', 'customers.list')).toBe(false)
    expect(isReportRead('GET', 'vat_filings.list')).toBe(false)
  })

  it('reads the registered query object, and gives up only when there is nothing to check against', () => {
    const base = { response: { success: z.unknown() } } as unknown as EndpointDefinition
    expect(registeredQueryParams({ ...base, request: { query: z.object({ period_id: z.string(), dim_no: z.string().optional() }) } })).toEqual([
      'period_id',
      'dim_no',
    ])
    // No query registered: the report takes no parameter at all.
    expect(registeredQueryParams(base)).toEqual([])
    expect(registeredQueryParams(undefined)).toBeNull()
    expect(registeredQueryParams({ ...base, request: { query: z.string() } })).toBeNull()
  })

  it('knows every spelling of a dimension filter', () => {
    expect([...DIMENSION_FILTER_QUERY_PARAMS].sort()).toEqual(['cost_center', 'dim_code', 'dim_no', 'dimensions', 'project'])
  })

  it('default mode refuses only unregistered dimension filters and reports the rest', () => {
    const q = new URLSearchParams('period_id=p&dim_no=6&dim_code=P1&project=P1&from=2026-01-01&x=1&dry_run=true')
    expect(reportQueryVerdict(q, ['period_id'], { strict: false })).toEqual({
      refused: ['dim_no', 'dim_code', 'project'],
      ignored: ['from', 'x'],
    })
    // A report that registers the pair keeps it; dry_run belongs to the wrapper.
    expect(reportQueryVerdict(q, ['period_id', 'dim_no', 'dim_code'], { strict: false })).toEqual({
      refused: ['project'],
      ignored: ['from', 'x'],
    })
  })

  it('strict mode refuses every unregistered parameter', () => {
    const q = new URLSearchParams('period_id=p&dim_no=6&from=2026-01-01&dry_run=true')
    expect(reportQueryVerdict(q, ['period_id'], { strict: true })).toEqual({ refused: ['dim_no', 'from'], ignored: [] })
  })
})

describe('withApiV1 report query gate (default mode)', () => {
  const PATH = '/api/v1/companies/:companyId/reports/zz-gate-probe'
  registerEndpoint({
    operation: 'reports.zz-gate-probe',
    method: 'GET',
    path: PATH,
    summary: 'Gate probe.',
    description: 'Test-only endpoint.',
    useWhen: 'Never.',
    doNotUseFor: 'Anything.',
    pitfalls: [],
    example: { response: { data: {} } },
    scope: 'reports:read',
    risk: 'low',
    idempotent: true,
    reversible: false,
    dryRunSupported: false,
    request: { query: z.object({ period_id: z.string(), to_date: z.string().optional() }) },
    response: { success: dataEnvelope(z.unknown()) },
  })
  const handler = vi.fn(async (_req: Request, ctx: ApiV1Context) => ok({ ran: true }, { requestId: ctx.requestId }))
  const GET = withApiV1<{ params: Promise<{ companyId: string }> }>('reports.zz-gate-probe', handler, {
    requireScope: 'reports:read',
  })
  const call = (query: string, headers: Record<string, string> = { Authorization: 'Bearer test-fixture-not-a-real-key' }) =>
    GET(new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/reports/zz-gate-probe${query}`, { headers }), {
      params: Promise.resolve({ companyId: COMPANY_ID }),
    })

  it('refuses a dimension filter the report does not register, before the handler or the import lease', async () => {
    const res = await call('?period_id=p&dim_no=6&dim_code=P001')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.unknown_params).toEqual(['dim_no', 'dim_code'])
    expect(body.error.details.allowed_params).toEqual(['period_id', 'to_date'])
    expect(handler).not.toHaveBeenCalled()
    expect(externalReportGuard).not.toHaveBeenCalled()
    // Stamped like any handler answer (the in-route refusals it replaces were).
    expect(res.headers.get('X-Request-Id')).toMatch(/^req_/)
    expect(res.headers.get('X-Robots-Tag')).toBe('noai, noimageai')
  })

  it('refuses the other spellings of a dimension filter too', async () => {
    for (const param of ['project', 'cost_center', 'dimensions']) {
      const res = await call(`?period_id=p&${param}=P001`)
      expect(res.status, param).toBe(400)
      expect((await res.json()).error.details.unknown_params, param).toEqual([param])
    }
    expect(handler).not.toHaveBeenCalled()
  })

  it('serves a stray parameter and names it in X-Ignored-Query-Params', async () => {
    const res = await call('?period_id=p&from=2026-01-01&page=2')
    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(res.headers.get('X-Ignored-Query-Params')).toBe('from, page')
  })

  it('a request with both refuses the dimension filter only', async () => {
    const res = await call('?period_id=p&page=2&dim_code=P001')
    expect(res.status).toBe(400)
    expect((await res.json()).error.details.unknown_params).toEqual(['dim_code'])
  })

  it('sends no header when every parameter is registered, dry_run included', async () => {
    const res = await call('?period_id=p&to_date=2026-06-30&dry_run=false')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Ignored-Query-Params')).toBeNull()
  })

  it('does not claim a parameter was ignored when the report itself failed', async () => {
    handler.mockImplementationOnce(async (_req: Request, ctx: ApiV1Context) =>
      v1ErrorResponseFromCode('NOT_FOUND', ctx.log, { requestId: ctx.requestId }),
    )
    const res = await call('?period_id=p&page=2')
    expect(res.status).toBe(404)
    expect(res.headers.get('X-Ignored-Query-Params')).toBeNull()
  })

  it('answers a company the key cannot reach with 404, never with the 400', async () => {
    mockServiceClient.mockReturnValue(makeSupabase(null))
    const res = await call('?period_id=p&dim_no=6&dim_code=P001')
    expect(res.status).toBe(404)
    expect(handler).not.toHaveBeenCalled()
  })

  it('401 without a key', async () => {
    const res = await call('?dim_no=6', {})
    expect(res.status).toBe(401)
  })

  it('leaves reads outside the report family alone', async () => {
    const listHandler = vi.fn(async (_req: Request, ctx: { requestId: string }) => ok([], { requestId: ctx.requestId }))
    const LIST = withApiV1<{ params: Promise<{ companyId: string }> }>('customers.zz-probe', listHandler, {
      requireScope: 'reports:read',
    })
    const res = await LIST(
      new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/customers-zz-probe?dim_no=6&anything=1`, {
        headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
      }),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(200)
    expect(listHandler).toHaveBeenCalledTimes(1)
    expect(res.headers.get('X-Ignored-Query-Params')).toBeNull()
  })
})

/** Every report read the registry knows, with the module that serves it. */
const REPORT_READS = listEndpoints().filter((ep) => isReportRead(ep.method, ep.operation) && !ep.path.includes('zz-gate-probe'))

function routeModule(path: string): string {
  return `@/app${path.replace(/:([^/]+)/g, '[$1]')}/route`
}

/**
 * The v1 reports that accept the dimension value filter. Every other report
 * must refuse dim_no/dim_code: a filtered statutory report is a wrong one.
 * reports.dimension-pnl registers dim_no as its column axis, not as a filter.
 */
const DIMENSION_FILTER_READS = new Set([
  'reports.income-statement',
  'reports.general-ledger',
  'reports.monthly-breakdown',
  'reports.kpi',
])

describe('every v1 report read is gated', () => {
  it('finds the report family in the registry', () => {
    // Guards the sweep below against silently testing nothing.
    expect(REPORT_READS.length).toBeGreaterThan(30)
  })

  it('registers an object query on every report read, so the gate never gives up', () => {
    const unchecked = REPORT_READS.filter((ep) => registeredQueryParams(ep) === null).map((ep) => ep.operation)
    expect(unchecked).toEqual([])
  })

  it('only the P&L-safe reports register the dimension filter pair', () => {
    const filterable = REPORT_READS.filter((ep) => registeredQueryParams(ep)?.includes('dim_code'))
      .map((ep) => ep.operation)
      .sort()
    expect(filterable).toEqual([...DIMENSION_FILTER_READS].sort())
  })

  it.each(REPORT_READS.map((ep) => [ep.operation, ep] as const))(
    '%s refuses a dimension filter it does not take, and only that',
    async (operation, ep) => {
      const mod = (await import(/* @vite-ignore */ routeModule(ep.path))) as {
        GET: (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>
      }
      // The key holds the endpoint's own scope (payroll:read for the salary reports).
      mockValidate.mockResolvedValue({
        userId: 'user-1',
        companyId: COMPANY_ID,
        apiKeyId: 'ak_1',
        apiKeyName: 'CI key',
        scopes: [...new Set(['reports:read', ep.scope])],
        mode: 'live',
      })
      const concrete = ep.path.replace(':companyId', COMPANY_ID).replace(/:[^/]+/g, RESOURCE_ID)
      // project is a dimension filter no report registers, so every report
      // refuses this request; what differs is whether dim_code is refused too.
      const res = await mod.GET(
        new Request(`https://x.test${concrete}?dim_no=6&dim_code=P001&project=P001&not_a_param=1`, {
          headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
        }),
        { params: Promise.resolve({ companyId: COMPANY_ID, id: RESOURCE_ID }) },
      )
      expect(res.status, operation).toBe(400)
      const body = await res.json()
      expect(body.error.code, operation).toBe('VALIDATION_ERROR')
      const refused: string[] = body.error.details.unknown_params
      expect(refused, operation).toContain('project')
      // dim_code is the filter value; dim_no alone is the axis of dimension-pnl.
      if (DIMENSION_FILTER_READS.has(operation)) {
        expect(refused, operation).not.toContain('dim_code')
      } else {
        expect(refused, operation).toContain('dim_code')
      }
      // Default mode never refuses a stray parameter.
      expect(refused, operation).not.toContain('not_a_param')
      // Refused before any report was produced.
      expect(externalReportGuard, operation).not.toHaveBeenCalled()
    },
  )
})
