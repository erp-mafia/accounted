/**
 * Tests for the v1 VAT filing record routes (issue #2746):
 *   GET    .../reports/vat-declaration/filings
 *   POST   .../reports/vat-declaration/filings
 *   DELETE .../reports/vat-declaration/filings
 *
 * Real withApiV1 wrapper (auth, scope, membership, dry-run); the store is
 * mocked (lib/vat/__tests__/filing-record-store.test.ts covers it).
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

const store = vi.hoisted(() => ({
  listVatFilings: vi.fn(),
  markVatPeriodFiled: vi.fn(),
  unmarkVatPeriodFiled: vi.fn(),
}))
vi.mock('@/lib/vat/filing-record-store', () => store)

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET, POST, DELETE } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

type MockResult = { data?: unknown; error?: unknown }
function makeFlexibleSupabase(byTable: Record<string, MockResult | MockResult[]>) {
  const queues = new Map<string, MockResult[]>()
  for (const [t, val] of Object.entries(byTable)) queues.set(t, Array.isArray(val) ? [...val] : [val])
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
const DEADLINE_ID = '11111111-1111-4111-8111-111111111111'
const BASE = `http://localhost/api/v1/companies/${COMPANY_ID}/reports/vat-declaration/filings`

const RECORD = {
  deadline_id: DEADLINE_ID,
  period_type: 'quarterly',
  year: 2026,
  period: 2,
  tax_period: '2026-Q2',
  filed_on: '2026-08-10',
  source: 'manual',
  reference: null,
}

function req(
  url: string,
  init: { method?: string; body?: unknown; dryRun?: boolean; auth?: boolean } = {},
): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (init.auth !== false) headers.Authorization = 'Bearer test-fixture-not-a-real-key'
  if (init.dryRun) headers['X-Dry-Run'] = 'true'
  return new Request(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
}

function authOk(scopes: string[]) {
  mockValidate.mockResolvedValue({
    valid: true,
    userId: 'user-1',
    keyId: 'key-1',
    keyName: 'Test key',
    scopes,
    mode: 'live',
  })
}

const params = () => ({ params: Promise.resolve({ companyId: COMPANY_ID }) }) as never

const validBody = { period_type: 'quarterly', year: 2026, period: 2, filed_on: '2026-08-10' }

describe('v1 VAT filing records', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { role: 'owner' } },
        idempotency_keys: { data: null },
      }),
    )
    store.listVatFilings.mockResolvedValue([RECORD])
    store.markVatPeriodFiled.mockResolvedValue({ ok: true, record: RECORD, created: false, changed: true })
    store.unmarkVatPeriodFiled.mockResolvedValue({ ok: true, deadline_id: DEADLINE_ID })
  })

  it('401 without a bearer token', async () => {
    const res = await GET(req(BASE, { auth: false }), params())
    expect(res.status).toBe(401)
  })

  it('GET lists the records under reports:read', async () => {
    authOk(['bookkeeping:write'])
    expect((await GET(req(BASE), params())).status).toBe(403)

    authOk(['reports:read'])
    const res = await GET(req(BASE), params())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual([RECORD])
    expect(store.listVatFilings).toHaveBeenCalledWith(expect.anything(), COMPANY_ID)
  })

  it('404 for a company the key holder is not a member of', async () => {
    authOk(['reports:read'])
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({ company_members: { data: null } }))
    const res = await GET(req(BASE), params())
    expect(res.status).toBe(404)
  })

  it('POST needs bookkeeping:write', async () => {
    authOk(['reports:read'])
    const res = await POST(req(BASE, { method: 'POST', body: validBody }), params())
    expect(res.status).toBe(403)
    expect(store.markVatPeriodFiled).not.toHaveBeenCalled()
  })

  it('POST 400 on an invalid body', async () => {
    authOk(['bookkeeping:write'])
    const res = await POST(
      req(BASE, { method: 'POST', body: { ...validBody, period: 7 } }),
      params(),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(store.markVatPeriodFiled).not.toHaveBeenCalled()
  })

  it('POST records the filing', async () => {
    authOk(['bookkeeping:write'])
    const res = await POST(
      req(BASE, { method: 'POST', body: { ...validBody, reference: 'KV-1' } }),
      params(),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ ...RECORD, created: false, changed: true })
    expect(store.markVatPeriodFiled).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, {
      periodType: 'quarterly',
      year: 2026,
      period: 2,
      filedOn: '2026-08-10',
      reference: 'KV-1',
      userId: 'user-1',
    })
  })

  it('POST answers 409 when the store loses a concurrent update', async () => {
    authOk(['bookkeeping:write'])
    store.markVatPeriodFiled.mockRejectedValue(
      Object.assign(new Error('row changed while it was being marked'), { code: 'CONFLICT' }),
    )
    const res = await POST(req(BASE, { method: 'POST', body: validBody }), params())
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('CONFLICT')
  })

  it('POST maps a store refusal to its status', async () => {
    authOk(['bookkeeping:write'])
    store.markVatPeriodFiled.mockResolvedValue({ ok: false, code: 'VAT_FILING_PERIOD_NOT_ENDED' })
    const res = await POST(req(BASE, { method: 'POST', body: validBody }), params())
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VAT_FILING_PERIOD_NOT_ENDED')
  })

  it('POST dry-run previews without writing, and still applies the date rules', async () => {
    authOk(['bookkeeping:write'])
    const preview = await POST(req(BASE, { method: 'POST', body: validBody, dryRun: true }), params())
    expect(preview.status).toBe(200)
    const body = await preview.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.would_mark).toMatchObject(validBody)
    expect(store.markVatPeriodFiled).not.toHaveBeenCalled()

    const future = await POST(
      req(BASE, { method: 'POST', body: { ...validBody, filed_on: '2099-01-01' }, dryRun: true }),
      params(),
    )
    expect(future.status).toBe(400)
    expect((await future.json()).error.code).toBe('VAT_FILING_DATE_IN_FUTURE')
  })

  it('DELETE 400 on a malformed query', async () => {
    authOk(['bookkeeping:write'])
    const res = await DELETE(req(`${BASE}?period_type=quarterly&year=2026`, { method: 'DELETE' }), params())
    expect(res.status).toBe(400)
    expect(store.unmarkVatPeriodFiled).not.toHaveBeenCalled()
  })

  it('DELETE maps not-found and confirmed refusals', async () => {
    authOk(['bookkeeping:write'])
    const url = `${BASE}?period_type=quarterly&year=2026&period=2`
    store.unmarkVatPeriodFiled.mockResolvedValueOnce({ ok: false, code: 'VAT_FILING_NOT_FOUND' })
    expect((await DELETE(req(url, { method: 'DELETE' }), params())).status).toBe(404)
    store.unmarkVatPeriodFiled.mockResolvedValueOnce({
      ok: false,
      code: 'VAT_FILING_CONFIRMED_BY_SKATTEVERKET',
    })
    expect((await DELETE(req(url, { method: 'DELETE' }), params())).status).toBe(409)
  })

  it('DELETE unmarks a manual filing', async () => {
    authOk(['bookkeeping:write'])
    const res = await DELETE(
      req(`${BASE}?period_type=quarterly&year=2026&period=2`, { method: 'DELETE' }),
      params(),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({ deadline_id: DEADLINE_ID, unmarked: true })
    expect(store.unmarkVatPeriodFiled).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, {
      periodType: 'quarterly',
      year: 2026,
      period: 2,
    })
  })
})
