/**
 * Tests for the v1 employee benefits endpoints (payroll gap-closure 5).
 *
 * GET/POST /employees/{id}/benefits. POST requires an Idempotency-Key and is
 * dry-runnable; a test key must be forced into dry-run and never write.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `benefits route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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
import { GET as listBenefits, POST as createBenefit } from '../route'

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
  const tableCalls: string[] = []
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(table)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null, count: null })
            resolve({ count: null, ...next })
          }
        }
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }
  return {
    tableCalls,
    from: vi.fn((table: string) => {
      tableCalls.push(table)
      return buildChain(table)
    }),
  }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const BENEFIT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const USER_ID = 'user-1'

const SAMPLE_ROW = {
  id: BENEFIT_ID,
  employee_id: EMPLOYEE_ID,
  benefit_type: 'bike',
  description: 'Cykelförmån',
  monthly_value: 1000,
  valid_from: '2026-03-01',
  valid_to: null,
  metadata: { annual_market_value: 15000, annual_taxable: 12000, tax_free_portion: 3000 },
  is_active: true,
  created_at: '2026-02-20T10:00:00Z',
  updated_at: '2026-02-20T10:00:00Z',
}

const BASE_URL = `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/benefits`

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      ...(init?.headers ?? {}),
    },
  })
}

function post(body: unknown, opts: { url?: string; idempotencyKey?: string | null } = {}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.idempotencyKey !== null) headers['Idempotency-Key'] = opts.idempotencyKey ?? 'idem-1'
  return makeRequest(opts.url ?? BASE_URL, { method: 'POST', body: JSON.stringify(body), headers })
}

function benefitParams(companyId: string, id: string) {
  return { params: Promise.resolve({ companyId, id }) }
}

function ownerMock(extra: Record<string, TableResp | TableResp[]> = {}) {
  return makeFlexibleSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    ...extra,
  })
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

describe('GET /api/v1/companies/:companyId/employees/:id/benefits', () => {
  it('lists benefits with qualified ids and annual_market_value lifted from metadata', async () => {
    mockServiceClient.mockReturnValue(
      ownerMock({
        employees: { data: { id: EMPLOYEE_ID }, error: null },
        employee_benefits: { data: [SAMPLE_ROW], error: null },
      }),
    )

    const res = await listBenefits(makeRequest(BASE_URL), benefitParams(COMPANY_ID, EMPLOYEE_ID))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toEqual({
      employee_benefit_id: BENEFIT_ID,
      benefit_type: 'bike',
      description: 'Cykelförmån',
      monthly_value: 1000,
      annual_market_value: 15000,
      valid_from: '2026-03-01',
      valid_to: null,
      is_active: true,
      metadata: SAMPLE_ROW.metadata,
      created_at: SAMPLE_ROW.created_at,
      updated_at: SAMPLE_ROW.updated_at,
    })
    expect(body.data[0].id).toBeUndefined()
    expect(body.data[0].employee_id).toBeUndefined()
  })

  it('accepts ?active=true and rejects any other value with VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(
      ownerMock({
        employees: { data: { id: EMPLOYEE_ID }, error: null },
        employee_benefits: { data: [], error: null },
      }),
    )
    const okRes = await listBenefits(makeRequest(`${BASE_URL}?active=true`), benefitParams(COMPANY_ID, EMPLOYEE_ID))
    expect(okRes.status).toBe(200)

    const badRes = await listBenefits(makeRequest(`${BASE_URL}?active=maybe`), benefitParams(COMPANY_ID, EMPLOYEE_ID))
    expect(badRes.status).toBe(400)
    const body = await badRes.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 EMPLOYEE_NOT_FOUND for an unknown employee', async () => {
    mockServiceClient.mockReturnValue(ownerMock({ employees: { data: null, error: null } }))

    const res = await listBenefits(makeRequest(BASE_URL), benefitParams(COMPANY_ID, EMPLOYEE_ID))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('EMPLOYEE_NOT_FOUND')
  })

  it('rejects a non-UUID employee id with 400', async () => {
    mockServiceClient.mockReturnValue(ownerMock())
    const res = await listBenefits(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/employees/not-a-uuid/benefits`),
      benefitParams(COMPANY_ID, 'not-a-uuid'),
    )
    expect(res.status).toBe(400)
  })

  it('rejects keys without payroll:read', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      apiKeyName: 'invoices only',
      scopes: ['invoices:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(ownerMock())
    const res = await listBenefits(makeRequest(BASE_URL), benefitParams(COMPANY_ID, EMPLOYEE_ID))
    expect(res.status).toBe(403)
  })
})

describe('POST /api/v1/companies/:companyId/employees/:id/benefits', () => {
  const carBody = {
    benefit_type: 'car',
    description: 'Bilförmån Volvo XC40',
    monthly_value: 4275,
    valid_from: '2026-01-01',
  }

  it('creates a benefit and answers 201 with the resource', async () => {
    mockServiceClient.mockReturnValue(
      ownerMock({
        employees: { data: { id: EMPLOYEE_ID }, error: null },
        employee_benefits: {
          data: { ...SAMPLE_ROW, benefit_type: 'car', description: carBody.description, monthly_value: 4275, metadata: {} },
          error: null,
        },
      }),
    )

    const res = await createBenefit(post(carBody), benefitParams(COMPANY_ID, EMPLOYEE_ID))

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.employee_benefit_id).toBe(BENEFIT_ID)
    expect(body.data.benefit_type).toBe('car')
    expect(body.data.annual_market_value).toBeNull()
  })

  it('dry-run previews the derived bike value without touching employee_benefits', async () => {
    const supabaseMock = ownerMock({ employees: { data: { id: EMPLOYEE_ID }, error: null } })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await createBenefit(
      post(
        { benefit_type: 'bike', description: 'Cykelförmån', annual_market_value: 15000, valid_from: '2026-03-01' },
        { url: `${BASE_URL}?dry_run=true` },
      ),
      benefitParams(COMPANY_ID, EMPLOYEE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.monthly_value).toBe(1000)
    expect(body.data.preview.annual_market_value).toBe(15000)
    expect(body.data.preview.employee_benefit_id).toBeUndefined()
    expect(supabaseMock.tableCalls).not.toContain('employee_benefits')
  })

  it('requires an Idempotency-Key', async () => {
    mockServiceClient.mockReturnValue(ownerMock())
    const res = await createBenefit(post(carBody, { idempotencyKey: null }), benefitParams(COMPANY_ID, EMPLOYEE_ID))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.issues[0].field).toBe('Idempotency-Key')
  })

  it('rejects a bike benefit without annual_market_value or monthly_value', async () => {
    mockServiceClient.mockReturnValue(ownerMock())
    const res = await createBenefit(
      post({ benefit_type: 'bike', description: 'Cykelförmån', valid_from: '2026-03-01' }),
      benefitParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.issues[0].field).toBe('annual_market_value')
  })

  it('rejects valid_to before valid_from with VALIDATION_ERROR on valid_to', async () => {
    mockServiceClient.mockReturnValue(ownerMock())
    const res = await createBenefit(
      post({ ...carBody, valid_from: '2026-06-01', valid_to: '2026-05-31' }),
      benefitParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.details.issues[0].field).toBe('valid_to')
  })

  it('returns 404 EMPLOYEE_NOT_FOUND for an unknown employee', async () => {
    mockServiceClient.mockReturnValue(ownerMock({ employees: { data: null, error: null } }))
    const res = await createBenefit(post(carBody), benefitParams(COMPANY_ID, EMPLOYEE_ID))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('EMPLOYEE_NOT_FOUND')
  })

  it('maps a CHECK violation from the insert to 400 VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(
      ownerMock({
        employees: { data: { id: EMPLOYEE_ID }, error: null },
        employee_benefits: { data: null, error: { code: '23514', message: 'violates check constraint' } },
      }),
    )
    const res = await createBenefit(post(carBody), benefitParams(COMPANY_ID, EMPLOYEE_ID))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('forces TEST KEYS into dry-run and never writes', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      apiKeyId: 'ak_test',
      apiKeyName: 'test key',
      scopes: ['payroll:read', 'payroll:write'],
      mode: 'test',
    })
    const supabaseMock = ownerMock({ employees: { data: { id: EMPLOYEE_ID }, error: null } })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await createBenefit(post(carBody), benefitParams(COMPANY_ID, EMPLOYEE_ID))

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    expect(res.headers.get('X-Gnubok-Mode')).toBe('test')
    expect(supabaseMock.tableCalls).not.toContain('employee_benefits')
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
    mockServiceClient.mockReturnValue(ownerMock())
    const res = await createBenefit(post(carBody), benefitParams(COMPANY_ID, EMPLOYEE_ID))
    expect(res.status).toBe(403)
  })

  it('returns 401 without a bearer token', async () => {
    mockValidate.mockResolvedValue(null)
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))
    const res = await createBenefit(
      new Request(BASE_URL, { method: 'POST', body: JSON.stringify(carBody), headers: { 'Idempotency-Key': 'idem-1' } }),
      benefitParams(COMPANY_ID, EMPLOYEE_ID),
    )
    expect(res.status).toBe(401)
  })
})
