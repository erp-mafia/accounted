/**
 * Integration tests for the v1 suppliers vertical (Phase 4 PR-1).
 *
 * Mirrors the customers test pattern: a Proxy-backed Supabase mock returns
 * whatever the route awaits, keyed by table name. Each suite focuses on
 * outcome (status / body shape) rather than query mechanics: the wrapper
 * already validates auth, scope, idempotency, and dry-run resolution.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `suppliers route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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
import { GET as listSuppliers, POST as createSupplier } from '../route'
import {
  GET as getSupplier,
  PATCH as updateSupplier,
  DELETE as deleteSupplier,
} from '../[id]/route'
import { POST as bulkCreateSuppliers } from '../bulk-create/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
  count?: number | null
}

function makeFlexibleSupabase(byTable: Record<string, TableResp | TableResp[]>) {
  // Per-table queue: TableResp[] consumes one entry per await, then sticks
  // on the last entry. Plain TableResp is treated as a constant.
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
const SUPPLIER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
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
    scopes: ['suppliers:read', 'suppliers:write'],
    mode: 'live',
  })
})

const SAMPLE_SUPPLIER = {
  id: SUPPLIER_ID,
  name: 'Office Depot AB',
  supplier_type: 'swedish_business',
  email: 'invoices@officedepot.test',
  phone: null,
  address_line1: null,
  address_line2: null,
  postal_code: null,
  city: null,
  country: 'SE',
  org_number: 'TEST-0000-0001',
  vat_number: 'SETEST00000001',
  bankgiro: '123-4567',
  plusgiro: null,
  bank_account: null,
  iban: null,
  bic: null,
  default_expense_account: '5410',
  default_payment_terms: 30,
  default_currency: 'SEK',
  notes: null,
  archived_at: null,
  created_at: '2026-04-12T08:30:00Z',
  updated_at: '2026-04-30T11:22:09Z',
}

describe('GET /api/v1/companies/:companyId/suppliers', () => {
  it('returns paginated suppliers, excluding archived by default', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        suppliers: { data: [SAMPLE_SUPPLIER], error: null },
      }),
    )

    const res = await listSuppliers(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/suppliers`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].name).toBe('Office Depot AB')
    expect(body.data[0].default_currency).toBe('SEK')
  })

  it('rejects unknown filter values with 400 VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        suppliers: { data: [], error: null },
      }),
    )
    const res = await listSuppliers(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/suppliers?supplier_type=individual`),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('GET /api/v1/companies/:companyId/suppliers/:id', () => {
  it('returns the supplier when found', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        suppliers: { data: SAMPLE_SUPPLIER, error: null },
      }),
    )

    const res = await getSupplier(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/suppliers/${SUPPLIER_ID}`),
      detailParams(COMPANY_ID, SUPPLIER_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.id).toBe(SUPPLIER_ID)
  })

  it('returns 404 NOT_FOUND when missing', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        suppliers: { data: null, error: null },
      }),
    )

    const res = await getSupplier(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/suppliers/${SUPPLIER_ID}`),
      detailParams(COMPANY_ID, SUPPLIER_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('rejects a non-UUID id with 400 VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )
    const res = await getSupplier(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/suppliers/not-a-uuid`),
      detailParams(COMPANY_ID, 'not-a-uuid'),
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /api/v1/companies/:companyId/suppliers', () => {
  it('creates a supplier (happy path)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        suppliers: { data: SAMPLE_SUPPLIER, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await createSupplier(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/suppliers`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Office Depot AB',
          supplier_type: 'swedish_business',
          org_number: 'TEST-0000-0001',
        }),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.name).toBe('Office Depot AB')
  })

  it('returns 409 SUPPLIER_DUPLICATE_ORG_NUMBER on a 23505', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        suppliers: { data: null, error: { code: '23505', message: 'duplicate' } },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await createSupplier(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/suppliers`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Office Depot AB',
          supplier_type: 'swedish_business',
          org_number: 'TEST-0000-0001',
        }),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('SUPPLIER_DUPLICATE_ORG_NUMBER')
    // GDPR Art.5(1)(c) defense-in-depth: error never echoes the value back.
    expect(JSON.stringify(body.error)).not.toContain('TEST-0000-0001')
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

    const res = await createSupplier(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/suppliers?dry_run=true`, {
        method: 'POST',
        body: JSON.stringify({
          name: 'Office Depot AB',
          supplier_type: 'swedish_business',
          org_number: 'TEST-0000-0001',
        }),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    // No supplier insert; only the membership check should have hit the DB.
    expect(fromSpy).not.toHaveBeenCalledWith('suppliers')
  })

  it('returns 400 when Idempotency-Key is missing', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const req = new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/suppliers`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test' },
      body: JSON.stringify({ name: 'X', supplier_type: 'swedish_business' }),
    })

    const res = await createSupplier(req, companyParams(COMPANY_ID))
    expect(res.status).toBe(400)
  })
})

describe('PATCH /api/v1/companies/:companyId/suppliers/:id', () => {
  it('updates an existing supplier', async () => {
    const updated = { ...SAMPLE_SUPPLIER, default_payment_terms: 14 }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        suppliers: { data: updated, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await updateSupplier(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/suppliers/${SUPPLIER_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ default_payment_terms: 14 }),
      }),
      detailParams(COMPANY_ID, SUPPLIER_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.default_payment_terms).toBe(14)
  })

  it('returns 400 VALIDATION_ERROR for an empty body', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await updateSupplier(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/suppliers/${SUPPLIER_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({}),
      }),
      detailParams(COMPANY_ID, SUPPLIER_ID),
    )

    expect(res.status).toBe(400)
  })

  it('refuses to edit identifying fields on an archived supplier (BFL 7 kap)', async () => {
    const archived = { ...SAMPLE_SUPPLIER, archived_at: '2026-01-01T00:00:00Z' }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        suppliers: { data: archived, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )
    const res = await updateSupplier(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/suppliers/${SUPPLIER_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Renamed AB' }),
      }),
      detailParams(COMPANY_ID, SUPPLIER_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('archived_at')
    expect(body.error.details.archived_at).toBe('2026-01-01T00:00:00Z')
  })

  it('allows un-archive (archived_at: null) on an archived supplier', async () => {
    const archived = { ...SAMPLE_SUPPLIER, archived_at: '2026-01-01T00:00:00Z' }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        // Queue: pre-flight fetch (archived) → final update select (un-archived)
        suppliers: [
          { data: archived, error: null },
          { data: { ...archived, archived_at: null }, error: null },
        ],
        idempotency_keys: { data: null, error: null },
      } as Record<string, TableResp | TableResp[]>),
    )
    const res = await updateSupplier(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/suppliers/${SUPPLIER_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived_at: null }),
      }),
      detailParams(COMPANY_ID, SUPPLIER_ID),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.archived_at).toBeNull()
  })

  it('allows non-identifying field edits (notes) on an archived supplier', async () => {
    // BFL 7 kap protects räkenskapsinformation: internal notes are not
    // referenced by any verifikation, so they remain editable.
    const archived = { ...SAMPLE_SUPPLIER, archived_at: '2026-01-01T00:00:00Z' }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        suppliers: [
          { data: archived, error: null },
          { data: { ...archived, notes: 'Updated internal note' }, error: null },
        ],
        idempotency_keys: { data: null, error: null },
      } as Record<string, TableResp | TableResp[]>),
    )
    const res = await updateSupplier(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/suppliers/${SUPPLIER_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ notes: 'Updated internal note' }),
      }),
      detailParams(COMPANY_ID, SUPPLIER_ID),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.notes).toBe('Updated internal note')
  })
})

describe('DELETE /api/v1/companies/:companyId/suppliers/:id', () => {
  it('archives a supplier with no open invoices (204)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: { data: null, error: null, count: 0 },
        suppliers: { data: { id: SUPPLIER_ID }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await deleteSupplier(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/suppliers/${SUPPLIER_ID}`, {
        method: 'DELETE',
      }),
      detailParams(COMPANY_ID, SUPPLIER_ID),
    )

    expect(res.status).toBe(204)
  })

  it('refuses to archive when open invoices exist (409 SUPPLIER_HAS_INVOICES)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        supplier_invoices: { data: null, error: null, count: 3 },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await deleteSupplier(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/suppliers/${SUPPLIER_ID}`, {
        method: 'DELETE',
      }),
      detailParams(COMPANY_ID, SUPPLIER_ID),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('SUPPLIER_HAS_INVOICES')
    expect(body.error.details.open_invoice_count).toBe(3)
  })
})

describe('POST /api/v1/companies/:companyId/suppliers/bulk-create', () => {
  it('partial-success: returns per-item ok/error rows', async () => {
    // First insert succeeds, second hits a 23505. The makeFlexibleSupabase
    // proxy returns the same response for every `from('suppliers')` await, so
    // for this case we wire a tiny custom client that flips on call count.
    let calls = 0
    mockServiceClient.mockReturnValue({
      from: (table: string) => {
        if (table !== 'suppliers') {
          return new Proxy({}, {
            get(_t, prop) {
              if (prop === 'then') return (r: (v: unknown) => void) => r({ data: table === 'company_members' ? { company_id: COMPANY_ID, role: 'owner' } : null, error: null })
              return () => new Proxy({}, this!)
            },
          })
        }
        const responses = [
          { data: { ...SAMPLE_SUPPLIER, id: 'first-id' }, error: null },
          { data: null, error: { code: '23505', message: 'duplicate' } },
        ]
        return new Proxy({}, {
          get(_t, prop) {
            if (prop === 'then') {
              const i = calls++
              return (r: (v: unknown) => void) => r(responses[Math.min(i, responses.length - 1)])
            }
            return () => new Proxy({}, this!)
          },
        })
      },
    })

    const res = await bulkCreateSuppliers(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/suppliers/bulk-create`, {
        method: 'POST',
        body: JSON.stringify({
          suppliers: [
            { name: 'A', supplier_type: 'swedish_business' },
            { name: 'B', supplier_type: 'swedish_business', org_number: 'TEST-DUP' },
          ],
        }),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.summary).toEqual({ total: 2, succeeded: 1, failed: 1 })
    expect(body.data.results[1].error.code).toBe('SUPPLIER_DUPLICATE_ORG_NUMBER')
  })

  it('rejects all_or_nothing: true with 501 NOT_IMPLEMENTED', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await bulkCreateSuppliers(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/suppliers/bulk-create`, {
        method: 'POST',
        body: JSON.stringify({
          suppliers: [{ name: 'A', supplier_type: 'swedish_business' }],
          all_or_nothing: true,
        }),
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(501)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_IMPLEMENTED')
  })
})
