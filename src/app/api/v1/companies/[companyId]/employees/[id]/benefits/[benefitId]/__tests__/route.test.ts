/**
 * Tests for the v1 single-benefit endpoints (payroll gap-closure 5).
 *
 * PATCH/DELETE /employees/{id}/benefits/{benefitId}. Both require an
 * Idempotency-Key and are dry-runnable. DELETE is a hard delete answering
 * 200 with the outcome (deleted or deactivated), or 404 when no row matched.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `benefit route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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
import { PATCH as patchBenefit, DELETE as deleteBenefit } from '../route'

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

const STORED = {
  id: BENEFIT_ID,
  employee_id: EMPLOYEE_ID,
  benefit_type: 'other',
  description: 'Friskvård',
  monthly_value: 500,
  valid_from: '2026-06-01',
  valid_to: '2026-12-31',
  metadata: {},
  is_active: true,
  created_at: '2026-05-01T08:00:00Z',
  updated_at: '2026-05-01T08:00:00Z',
}

const BASE_URL = `https://x.test/api/v1/companies/${COMPANY_ID}/employees/${EMPLOYEE_ID}/benefits/${BENEFIT_ID}`

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': 'idem-1',
      ...(init?.headers ?? {}),
    },
  })
}

function patch(body: unknown, url = BASE_URL): Request {
  return makeRequest(url, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

function del(url = BASE_URL): Request {
  return makeRequest(url, { method: 'DELETE' })
}

const params = { params: Promise.resolve({ companyId: COMPANY_ID, id: EMPLOYEE_ID, benefitId: BENEFIT_ID }) }

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

describe('PATCH /api/v1/companies/:companyId/employees/:id/benefits/:benefitId', () => {
  it('updates the benefit and returns the resource', async () => {
    mockServiceClient.mockReturnValue(
      ownerMock({
        employee_benefits: [
          { data: STORED, error: null }, // existence + merge fetch
          { data: { ...STORED, valid_to: '2026-06-30' }, error: null }, // update
        ],
      }),
    )

    const res = await patchBenefit(patch({ valid_to: '2026-06-30' }), params)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.employee_benefit_id).toBe(BENEFIT_ID)
    expect(body.data.valid_to).toBe('2026-06-30')
    expect(body.data.id).toBeUndefined()
  })

  it('returns 404 NOT_FOUND when the benefit is not on the employee', async () => {
    mockServiceClient.mockReturnValue(ownerMock({ employee_benefits: { data: null, error: null } }))
    const res = await patchBenefit(patch({ monthly_value: 100 }), params)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('rejects a valid_to-only patch that predates the stored valid_from (merged check)', async () => {
    const supabaseMock = ownerMock({ employee_benefits: { data: STORED, error: null } })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await patchBenefit(patch({ valid_to: '2026-05-31' }), params)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.issues[0].field).toBe('valid_to')
    // Fetched once, never written.
    expect(supabaseMock.tableCalls.filter((t) => t === 'employee_benefits')).toHaveLength(1)
  })

  it('rejects annual_market_value on a non-bike benefit', async () => {
    mockServiceClient.mockReturnValue(ownerMock({ employee_benefits: { data: STORED, error: null } }))
    const res = await patchBenefit(patch({ annual_market_value: 12000 }), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.details.issues[0].field).toBe('annual_market_value')
  })

  it('rejects an empty body', async () => {
    mockServiceClient.mockReturnValue(ownerMock())
    const res = await patchBenefit(patch({}), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('dry-run returns the merged preview without writing', async () => {
    const supabaseMock = ownerMock({ employee_benefits: { data: STORED, error: null } })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await patchBenefit(patch({ is_active: false }, `${BASE_URL}?dry_run=true`), params)

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.preview.employee_benefit_id).toBe(BENEFIT_ID)
    expect(body.data.preview.is_active).toBe(false)
    expect(supabaseMock.tableCalls.filter((t) => t === 'employee_benefits')).toHaveLength(1)
  })

  it('requires an Idempotency-Key', async () => {
    mockServiceClient.mockReturnValue(ownerMock())
    const res = await patchBenefit(
      new Request(BASE_URL, {
        method: 'PATCH',
        body: JSON.stringify({ monthly_value: 100 }),
        headers: { Authorization: 'Bearer test-fixture-not-a-real-key', 'Content-Type': 'application/json' },
      }),
      params,
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.details.issues[0].field).toBe('Idempotency-Key')
  })

  it('rejects a non-UUID benefit id with 400', async () => {
    mockServiceClient.mockReturnValue(ownerMock())
    const res = await patchBenefit(patch({ monthly_value: 100 }), {
      params: Promise.resolve({ companyId: COMPANY_ID, id: EMPLOYEE_ID, benefitId: 'ben-1' }),
    })
    expect(res.status).toBe(400)
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
    const res = await patchBenefit(patch({ monthly_value: 100 }), params)
    expect(res.status).toBe(403)
  })
})

describe('DELETE /api/v1/companies/:companyId/employees/:id/benefits/:benefitId', () => {
  it('hard-deletes an unreferenced benefit and answers 200 with the outcome', async () => {
    const supabaseMock = ownerMock({
      salary_line_items: { data: null, count: 0, error: null },
      employee_benefits: { data: [{ id: BENEFIT_ID }], error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await deleteBenefit(del(), params)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({ employee_benefit_id: BENEFIT_ID, deleted: true, deactivated: false })
    expect(supabaseMock.tableCalls).toContain('employee_benefits')
  })

  it('keeps and deactivates a benefit that a payslip line already derives from', async () => {
    const supabaseMock = ownerMock({
      salary_line_items: { data: null, count: 1, error: null },
      employee_benefits: { data: [{ id: BENEFIT_ID }], error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await deleteBenefit(del(), params)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({ employee_benefit_id: BENEFIT_ID, deleted: false, deactivated: true })
  })

  it('keeps and deactivates when the foreign key refuses a delete the count let through (#2801)', async () => {
    const supabaseMock = ownerMock({
      // The count read 0, then a recalculation derived a line...
      salary_line_items: { data: null, count: 0, error: null },
      employee_benefits: [
        // ...so the NO ACTION key (migration 20260920190100) refuses the delete,
        {
          data: null,
          error: { code: '23503', message: 'violates foreign key constraint "salary_line_items_source_benefit_id_fkey"' },
        },
        // and the row is switched off instead.
        { data: [{ id: BENEFIT_ID }], error: null },
      ],
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await deleteBenefit(del(), params)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({ employee_benefit_id: BENEFIT_ID, deleted: false, deactivated: true })
  })

  it('returns 404 NOT_FOUND when no row matched', async () => {
    mockServiceClient.mockReturnValue(ownerMock({ employee_benefits: { data: [], error: null } }))
    const res = await deleteBenefit(del(), params)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('dry-run previews the row that would go without deleting', async () => {
    mockServiceClient.mockReturnValue(ownerMock({ employee_benefits: { data: STORED, error: null } }))

    const res = await deleteBenefit(del(`${BASE_URL}?dry_run=true`), params)

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.employee_benefit_id).toBe(BENEFIT_ID)
  })

  it('requires an Idempotency-Key', async () => {
    mockServiceClient.mockReturnValue(ownerMock())
    const res = await deleteBenefit(
      new Request(BASE_URL, { method: 'DELETE', headers: { Authorization: 'Bearer test-fixture-not-a-real-key' } }),
      params,
    )
    expect(res.status).toBe(400)
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
    const res = await deleteBenefit(del(), params)
    expect(res.status).toBe(403)
  })

  it('returns 401 without a bearer token', async () => {
    mockValidate.mockResolvedValue(null)
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))
    const res = await deleteBenefit(new Request(BASE_URL, { method: 'DELETE' }), params)
    expect(res.status).toBe(401)
  })
})
