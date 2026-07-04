/**
 * Integration tests for GET /api/v1/companies/:companyId/customers and
 * /api/v1/companies/:companyId/customers/:id.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  // Belt-and-braces: ensure we never reach a real DB from this test suite.
  // Supabase clients are mocked, but if a future test refactor accidentally
  // bypassed the mock, this assertion fails the run rather than silently
  // touching production. (Compliance: ISO 27001:2022 A.8.33: test data
  // separation.)
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `customers route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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

// Mock VIES validation so customer-write tests never make a real network
// call. Tests can override per-case via mockResolvedValueOnce.
vi.mock('@/lib/vat/vies-client', () => ({
  validateVatNumber: vi.fn().mockResolvedValue({ valid: false }),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as listCustomers, POST as createCustomer } from '../route'
import {
  GET as getCustomer,
  PATCH as updateCustomer,
  DELETE as deleteCustomer,
} from '../[id]/route'

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

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const CUSTOMER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const USER_ID = 'user-1'

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(url, {
    ...init,
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key', ...(init?.headers ?? {}) },
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
    scopes: ['customers:read'],
    mode: 'live',
  })
})

// Deliberately fake org_number / vat_number: cannot be confused with real
// Bolagsverket-registered entities and cannot pass VIES validation. The
// 'TEST-' prefix makes it obvious to log scrapers and secret scanners that
// these are test fixtures.
const SAMPLE_CUSTOMER = {
  id: CUSTOMER_ID,
  name: 'Acme AB',
  customer_type: 'swedish_business',
  email: 'a@acme.test',
  phone: null,
  address_line1: null,
  address_line2: null,
  postal_code: null,
  city: null,
  country: 'Sweden',
  org_number: 'TEST-0000-0001',
  vat_number: 'SETEST00000001',
  vat_number_validated: true,
  vat_number_validated_at: '2025-04-12T09:00:00Z',
  default_payment_terms: 30,
  notes: null,
  archived_at: null,
  created_at: '2025-04-12T08:30:00Z',
  updated_at: '2026-04-30T11:22:09Z',
}

describe('GET /api/v1/companies/:companyId/customers', () => {
  it('returns a paginated customer list, excluding archived rows by default', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: [SAMPLE_CUSTOMER], error: null },
      }),
    )

    const res = await listCustomers(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].name).toBe('Acme AB')
    expect(body.data[0].org_number).toBe('TEST-0000-0001')
  })

  it('masks org_number and vat_number in the list response for individual customer_types', async () => {
    const individual = {
      ...SAMPLE_CUSTOMER,
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      customer_type: 'individual',
      org_number: '195512319876', // would be a personnummer in real life
      vat_number: null,
    }
    const business = {
      ...SAMPLE_CUSTOMER,
      customer_type: 'swedish_business',
    }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: [individual, business], error: null },
      }),
    )

    const res = await listCustomers(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(2)
    // Individual: org_number & vat_number masked to null in the list.
    const individualRow = body.data.find((c: { customer_type: string }) => c.customer_type === 'individual')
    expect(individualRow.org_number).toBeNull()
    expect(individualRow.vat_number).toBeNull()
    // Business: Bolagsverket-public org_number remains visible.
    const businessRow = body.data.find((c: { customer_type: string }) => c.customer_type === 'swedish_business')
    expect(businessRow.org_number).toBe('TEST-0000-0001')
    expect(businessRow.vat_number).toBe('SETEST00000001')
  })

  it('accepts include_archived=true', async () => {
    const archived = { ...SAMPLE_CUSTOMER, archived_at: '2026-01-01T00:00:00Z' }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: [SAMPLE_CUSTOMER, archived], error: null },
      }),
    )

    const res = await listCustomers(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers?include_archived=true`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(2)
  })

  it('rejects an invalid customer_type filter', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await listCustomers(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers?customer_type=alien`),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('emits a next_cursor when the page is full', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: {
          data: [
            SAMPLE_CUSTOMER,
            { ...SAMPLE_CUSTOMER, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
          ],
          error: null,
        },
      }),
    )

    const res = await listCustomers(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers?limit=1`),
      companyParams(COMPANY_ID),
    )

    const body = await res.json()
    expect(body.data).toHaveLength(1)
    expect(body.meta.next_cursor).toBeTruthy()
  })
})

describe('GET /api/v1/companies/:companyId/customers/:id', () => {
  it('returns the customer record', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: SAMPLE_CUSTOMER, error: null },
      }),
    )

    const res = await getCustomer(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers/${CUSTOMER_ID}`),
      detailParams(COMPANY_ID, CUSTOMER_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.id).toBe(CUSTOMER_ID)
    expect(body.data.name).toBe('Acme AB')
    // Default response MUST NOT include the invoices expansion.
    expect(body.data.invoices).toBeUndefined()
  })

  it('soft-degrades and signals partial_expansions when the invoices subquery fails', async () => {
    // Custom mock: customers succeeds, invoices subquery returns an error.
    const supabaseMock = {
      from: vi.fn((table: string) => {
        const result =
          table === 'company_members'
            ? { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
            : table === 'customers'
              ? { data: SAMPLE_CUSTOMER, error: null }
              : table === 'invoices'
                ? { data: null, error: { code: '42501', message: 'permission denied for table invoices' } }
                : { data: null, error: null }
        const handler: ProxyHandler<object> = {
          get(_t, prop) {
            if (prop === 'then') {
              return (resolve: (v: unknown) => void) => resolve(result)
            }
            return (..._args: unknown[]) => new Proxy({}, handler)
          },
        }
        return new Proxy({}, handler)
      }),
    }
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await getCustomer(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/customers/${CUSTOMER_ID}?expand=invoices`,
      ),
      detailParams(COMPANY_ID, CUSTOMER_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    // Primary resource still returns.
    expect(body.data.id).toBe(CUSTOMER_ID)
    // Failed expansion falls back to an empty array …
    expect(body.data.invoices).toEqual([])
    // … and the caller is signalled via meta so they can detect the
    // degraded response without re-parsing the body.
    expect(body.meta.partial_expansions).toEqual(['invoices'])
  })

  it('embeds open invoices when ?expand=invoices is requested', async () => {
    const openInvoice = {
      id: 'inv-open-1',
      invoice_number: '2026-0001',
      invoice_date: '2026-04-01',
      due_date: '2026-04-30',
      status: 'sent',
      currency: 'SEK',
      total: 5000,
      remaining_amount: 5000,
    }
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: SAMPLE_CUSTOMER, error: null },
        invoices: { data: [openInvoice], error: null },
      }),
    )

    const res = await getCustomer(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/customers/${CUSTOMER_ID}?expand=invoices`,
      ),
      detailParams(COMPANY_ID, CUSTOMER_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.invoices).toHaveLength(1)
    expect(body.data.invoices[0].id).toBe('inv-open-1')
    // Successful expansion MUST NOT set the partial flag.
    expect(body.meta.partial_expansions).toBeUndefined()
  })

  it('returns 404 when the customer does not exist for the company', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: null, error: null },
      }),
    )

    const res = await getCustomer(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers/${CUSTOMER_ID}`),
      detailParams(COMPANY_ID, CUSTOMER_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('returns 400 VALIDATION_ERROR when :id is not a UUID', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await getCustomer(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers/not-a-uuid`),
      detailParams(COMPANY_ID, 'not-a-uuid'),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('id')
  })

  it('does not echo the queried id on 404 (enumeration hardening)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: null, error: null },
      }),
    )

    const res = await getCustomer(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers/${CUSTOMER_ID}`),
      detailParams(COMPANY_ID, CUSTOMER_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.details).toEqual({ resource: 'customer' })
    expect(body.error.details.id).toBeUndefined()
  })
})

// ──────────────────────────────────────────────────────────────────
// POST /api/v1/companies/:companyId/customers
// ──────────────────────────────────────────────────────────────────

function withWriteScope() {
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['customers:write'],
    mode: 'live',
  })
}

function makePostRequest(url: string, body: unknown, extraHeaders: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'abcd1234-1111-4abc-8def-1234567890ab',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  })
}

function makePatchRequest(url: string, body: unknown, extraHeaders: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'abcd1234-2222-4abc-8def-1234567890ab',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  })
}

function makeDeleteRequest(url: string, extraHeaders: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'DELETE',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': 'abcd1234-3333-4abc-8def-1234567890ab',
      ...extraHeaders,
    },
  })
}

describe('POST /api/v1/companies/:companyId/customers', () => {
  it('creates a customer and returns 201 with the new record', async () => {
    withWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: { ...SAMPLE_CUSTOMER, name: 'New Co AB' }, error: null },
      }),
    )

    const res = await createCustomer(
      makePostRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers`, {
        name: 'New Co AB',
        customer_type: 'swedish_business',
        email: 'a@newco.test',
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.name).toBe('New Co AB')
  })

  it('rejects requests without an Idempotency-Key header', async () => {
    withWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const req = new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/customers`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-fixture-not-a-real-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'X', customer_type: 'swedish_business' }),
    })

    const res = await createCustomer(req, companyParams(COMPANY_ID))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when body is missing required fields', async () => {
    withWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await createCustomer(
      makePostRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers`, {
        email: 'no@name.test',
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 409 on duplicate org_number', async () => {
    withWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: null, error: { code: '23505', message: 'duplicate key' } },
      }),
    )

    const res = await createCustomer(
      makePostRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers`, {
        name: 'Dupe AB',
        customer_type: 'swedish_business',
        org_number: 'TEST-0000-0001',
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('CUSTOMER_DUPLICATE_ORG_NUMBER')
  })

  it('dry-run returns 200 with X-Dry-Run header and preview shape; no insert', async () => {
    withWriteScope()
    const supabaseMock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await createCustomer(
      makePostRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers?dry_run=true`, {
        name: 'Preview AB',
        customer_type: 'swedish_business',
        email: 'p@preview.test',
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.name).toBe('Preview AB')
    expect(body.data.preview.id).toBeNull()
    expect(body.data.preview.created_at).toBeNull()
    // The `customers` table was never queried for an insert/select.
    const inserted = supabaseMock.from.mock.calls.some((c) => c[0] === 'customers')
    expect(inserted).toBe(false)
  })

  it('rejects keys without customers:write scope', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      scopes: ['customers:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await createCustomer(
      makePostRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers`, {
        name: 'X',
        customer_type: 'swedish_business',
      }),
      companyParams(COMPANY_ID),
    )

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
  })
})

// ──────────────────────────────────────────────────────────────────
// PATCH /api/v1/companies/:companyId/customers/:id
// ──────────────────────────────────────────────────────────────────

describe('PATCH /api/v1/companies/:companyId/customers/:id', () => {
  it('updates a customer and returns the new record', async () => {
    withWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: {
          data: { ...SAMPLE_CUSTOMER, default_payment_terms: 14 },
          error: null,
        },
      }),
    )

    const res = await updateCustomer(
      makePatchRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers/${CUSTOMER_ID}`, {
        default_payment_terms: 14,
      }),
      detailParams(COMPANY_ID, CUSTOMER_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.default_payment_terms).toBe(14)
  })

  it('rejects an empty body', async () => {
    withWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await updateCustomer(
      makePatchRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers/${CUSTOMER_ID}`, {}),
      detailParams(COMPANY_ID, CUSTOMER_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 VALIDATION_ERROR when :id is not a UUID', async () => {
    withWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await updateCustomer(
      makePatchRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers/not-a-uuid`, {
        name: 'X',
      }),
      detailParams(COMPANY_ID, 'not-a-uuid'),
    )

    expect(res.status).toBe(400)
  })

  it('dry-run merges the proposed changes with the current record', async () => {
    withWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: SAMPLE_CUSTOMER, error: null },
      }),
    )

    const res = await updateCustomer(
      makePatchRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/customers/${CUSTOMER_ID}?dry_run=true`,
        { default_payment_terms: 7 },
      ),
      detailParams(COMPANY_ID, CUSTOMER_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.default_payment_terms).toBe(7)
    // Unchanged fields from the current record are preserved.
    expect(body.data.preview.name).toBe(SAMPLE_CUSTOMER.name)
  })

  it('returns 404 when the customer does not exist', async () => {
    withWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: null, error: null },
      }),
    )

    const res = await updateCustomer(
      makePatchRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers/${CUSTOMER_ID}`, {
        name: 'New name',
      }),
      detailParams(COMPANY_ID, CUSTOMER_ID),
    )

    expect(res.status).toBe(404)
  })

  it('accepts archived_at: null for un-archive', async () => {
    withWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: { ...SAMPLE_CUSTOMER, archived_at: null }, error: null },
      }),
    )

    const res = await updateCustomer(
      makePatchRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers/${CUSTOMER_ID}`, {
        archived_at: null,
      }),
      detailParams(COMPANY_ID, CUSTOMER_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.archived_at).toBeNull()
  })

  it('rejects an archived_at value that is not null', async () => {
    withWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await updateCustomer(
      makePatchRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers/${CUSTOMER_ID}`, {
        archived_at: '2026-05-12T00:00:00Z',
      }),
      detailParams(COMPANY_ID, CUSTOMER_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})

// ──────────────────────────────────────────────────────────────────
// DELETE /api/v1/companies/:companyId/customers/:id
// ──────────────────────────────────────────────────────────────────

describe('DELETE /api/v1/companies/:companyId/customers/:id', () => {
  it('soft-deletes the customer and returns 204', async () => {
    withWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: { id: CUSTOMER_ID }, error: null },
      }),
    )

    const res = await deleteCustomer(
      makeDeleteRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers/${CUSTOMER_ID}`),
      detailParams(COMPANY_ID, CUSTOMER_ID),
    )

    expect(res.status).toBe(204)
  })

  it('dry-run previews the archived state without modifying the customer', async () => {
    withWriteScope()
    const supabaseMock = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      customers: { data: SAMPLE_CUSTOMER, error: null },
    })
    mockServiceClient.mockReturnValue(supabaseMock)

    const res = await deleteCustomer(
      makeDeleteRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/customers/${CUSTOMER_ID}?dry_run=true`,
      ),
      detailParams(COMPANY_ID, CUSTOMER_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.archived_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('returns 404 when the customer does not exist', async () => {
    withWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        customers: { data: null, error: null },
      }),
    )

    const res = await deleteCustomer(
      makeDeleteRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers/${CUSTOMER_ID}`),
      detailParams(COMPANY_ID, CUSTOMER_ID),
    )

    expect(res.status).toBe(404)
  })

  it('refuses to archive a customer with open invoices', async () => {
    withWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        // The open-invoice pre-flight query returns count > 0.
        invoices: { data: [], error: null, count: 3 },
      }),
    )

    const res = await deleteCustomer(
      makeDeleteRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers/${CUSTOMER_ID}`),
      detailParams(COMPANY_ID, CUSTOMER_ID),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('CUSTOMER_HAS_INVOICES')
    expect(body.error.details.open_invoice_count).toBe(3)
  })

  it('returns 400 VALIDATION_ERROR when :id is not a UUID', async () => {
    withWriteScope()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await deleteCustomer(
      makeDeleteRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/customers/not-a-uuid`),
      detailParams(COMPANY_ID, 'not-a-uuid'),
    )

    expect(res.status).toBe(400)
  })
})
