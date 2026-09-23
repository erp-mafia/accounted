/**
 * Integration tests for POST /api/v1/companies/:companyId/customers/bulk-create.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `customer bulk-create tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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
vi.mock('@/lib/vat/vies-client', () => ({
  validateVatNumber: vi.fn().mockResolvedValue({ valid: false }),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as bulkCreate } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

type MockResult = { data?: unknown; error?: unknown }
function makeFlexibleSupabase(byTable: Record<string, MockResult | MockResult[]>) {
  const queues = new Map<string, MockResult[]>()
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
const USER_ID = 'user-1'

function makeRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem1234-5050-4abc-8def-1234567890ab',
    },
    body: JSON.stringify(body),
  })
}
function companyParams(companyId: string) {
  return { params: Promise.resolve({ companyId }) }
}

const SAMPLE = (name = 'Acme AB') => ({
  name,
  customer_type: 'swedish_business' as const,
  org_number: '556677-8899',
})

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['customers:write'],
    mode: 'live',
  })
})

describe('POST /api/v1/companies/:companyId/customers/bulk-create', () => {
  it('creates two customers and returns a 200 with summary', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: [
          { data: { id: 'c1', name: 'Acme', customer_type: 'swedish_business' }, error: null },
          { data: { id: 'c2', name: 'Beta', customer_type: 'swedish_business' }, error: null },
        ],
      }),
    )

    const res = await bulkCreate(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers/bulk-create`, {
        customers: [SAMPLE('Acme AB'), SAMPLE('Beta AB')],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.summary).toEqual({ total: 2, succeeded: 2, failed: 0 })
    expect(body.data.results[0]).toMatchObject({ ok: true, request_index: 0 })
    expect(body.data.results[1]).toMatchObject({ ok: true, request_index: 1 })
  })

  it('returns per-item failure for org_number duplicate', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: null, error: { code: '23505', message: 'duplicate' } },
      }),
    )

    const res = await bulkCreate(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers/bulk-create`, {
        customers: [SAMPLE('Acme AB')],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.summary.failed).toBe(1)
    expect(body.data.results[0].error.code).toBe('CUSTOMER_DUPLICATE_ORG_NUMBER')
    // Ensure org_number value is NOT echoed (GDPR Art.5(1)(c)).
    expect(JSON.stringify(body.data.results[0].error.details)).not.toContain('556677-8899')
  })

  it('rejects more than 50 customers per request', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const customers = Array.from({ length: 51 }, () => SAMPLE())

    const res = await bulkCreate(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers/bulk-create`, {
        customers,
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects all_or_nothing: true with 501 NOT_IMPLEMENTED', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await bulkCreate(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers/bulk-create`, {
        all_or_nothing: true,
        customers: [SAMPLE()],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(501)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_IMPLEMENTED')
  })

  it('dry-run returns previews without inserting', async () => {
    const supabaseMock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await bulkCreate(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/customers/bulk-create?dry_run=true`,
        { customers: [SAMPLE()] },
      ),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.summary.succeeded).toBe(1)
    // No `customers` insert was attempted.
    const insertedCustomer = supabaseMock.from.mock.calls.some((c) => c[0] === 'customers')
    expect(insertedCustomer).toBe(false)
  })

  it('rejects empty customers array', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await bulkCreate(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers/bulk-create`, {
        customers: [],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects keys without customers:write scope', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      scopes: ['customers:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await bulkCreate(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers/bulk-create`, {
        customers: [SAMPLE()],
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(403)
  })
})
