/**
 * The report query gate with STRICT_REPORT_QUERY_PARAMS on: the full
 * strictness the switch holds back until API users have been told. Pinned so
 * flipping it is a one-line change with known behavior: every query
 * parameter a report does not register answers 400, and nothing is served
 * as ignored. Default mode is covered in report-query-gate.test.ts.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('../report-period', async () => {
  const actual = await vi.importActual<typeof import('../report-period')>('../report-period')
  return { ...actual, STRICT_REPORT_QUERY_PARAMS: true }
})
vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEExternalReport: (_s: unknown, _c: unknown, _op: unknown, read: () => unknown) => read(),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { registerEndpoint, dataEnvelope } from '../registry'
import { STRICT_REPORT_QUERY_PARAMS } from '../report-period'
import { withApiV1, type ApiV1Context } from '../with-api-v1'
import { ok } from '../response'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function makeSupabase() {
  const build = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
          if (prop === 'maybeSingle' || prop === 'single') {
            const row = table === 'company_members' ? { company_id: COMPANY_ID, role: 'owner' } : null
            return () => Promise.resolve({ data: row, error: null })
          }
          return () => build(table)
        },
      },
    )
  return { from: vi.fn((table: string) => build(table)) }
}

registerEndpoint({
  operation: 'reports.zz-strict-probe',
  method: 'GET',
  path: '/api/v1/companies/:companyId/reports/zz-strict-probe',
  summary: 'Strict gate probe.',
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
  request: { query: z.object({ period_id: z.string() }) },
  response: { success: dataEnvelope(z.unknown()) },
})
const handler = vi.fn(async (_req: Request, ctx: ApiV1Context) => ok({ ran: true }, { requestId: ctx.requestId }))
const GET = withApiV1<{ params: Promise<{ companyId: string }> }>('reports.zz-strict-probe', handler, {
  requireScope: 'reports:read',
})
const call = (query: string) =>
  GET(
    new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/reports/zz-strict-probe${query}`, {
      headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
    }),
    { params: Promise.resolve({ companyId: COMPANY_ID }) },
  )

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['reports:read'],
    mode: 'live',
  })
  mockServiceClient.mockReturnValue(makeSupabase())
})

describe('withApiV1 report query gate (strict mode)', () => {
  it('runs with the switch on', () => {
    expect(STRICT_REPORT_QUERY_PARAMS).toBe(true)
  })

  it('refuses a stray parameter it would otherwise serve', async () => {
    const res = await call('?period_id=p&from=2026-01-01&page=2')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.unknown_params).toEqual(['from', 'page'])
    expect(body.error.details.message).toMatch(/^Unknown query parameter\(s\): from, page\./)
    expect(handler).not.toHaveBeenCalled()
  })

  it('refuses a dimension filter the same way', async () => {
    const res = await call('?period_id=p&dim_no=6&dim_code=P001')
    expect(res.status).toBe(400)
    expect((await res.json()).error.details.unknown_params).toEqual(['dim_no', 'dim_code'])
  })

  it('serves the registered query and the wrapper\'s dry_run, reporting nothing', async () => {
    const res = await call('?period_id=p&dry_run=false')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Ignored-Query-Params')).toBeNull()
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
