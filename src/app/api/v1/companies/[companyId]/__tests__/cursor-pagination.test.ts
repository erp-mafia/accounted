/**
 * Cursor-pagination contract for every v1 list endpoint that pages with the
 * default (created_at, id) keyset cursor.
 *
 * Regression lock for the P0 where invoices / journal-entries /
 * supplier-invoices encoded the cursor on a Postgres `date` column
 * (invoice_date / entry_date). PostgREST serializes `date` as "2026-07-25",
 * `decodeDefaultCursor` rejects anything that is not a full ISO-8601
 * timestamp, so the keyset predicate was never applied: page 2 returned
 * page 1, forever, while still advertising a fresh next_cursor. An
 * integrator syncing verifikat looped on the newest rows indefinitely.
 *
 * The mock here is NOT the usual pass-through Proxy: it is a small in-memory
 * PostgREST that actually evaluates .eq/.neq/.gte/.lte/.or/.order/.limit.
 * A pass-through mock cannot catch this bug at all, because the bug is that
 * the filter is never sent. Anything the routes emit that the mini-parser
 * does not understand throws, so the suite fails loudly instead of passing
 * vacuously.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `cursor pagination tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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
import { decodeDefaultCursor } from '@/lib/api/v1/pagination'
import { GET as listInvoices } from '../invoices/route'
import { GET as listJournalEntries } from '../journal-entries/route'
import { GET as listSupplierInvoices } from '../supplier-invoices/route'
import { GET as listTransactions } from '../transactions/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

// ──────────────────────────────────────────────────────────────────
// In-memory PostgREST
// ──────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>

/**
 * String comparison, which matches Postgres ordering for the two column
 * kinds this harness sorts on: same-format ISO-8601 timestamps (lexical
 * order == chronological order) and lowercase-hex UUIDs.
 */
function cmp(a: unknown, b: unknown): number {
  const left = a === null || a === undefined ? '' : String(a)
  const right = b === null || b === undefined ? '' : String(b)
  return left < right ? -1 : left > right ? 1 : 0
}

/** Split a PostgREST filter list on commas that are not inside and(...)/or(...). */
function splitTopLevel(expression: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of expression) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current) parts.push(current)
  return parts
}

/** Evaluate a single `column.operator.value` term (or a nested and(...) group). */
function matchesTerm(row: Row, term: string): boolean {
  if (term.startsWith('and(') && term.endsWith(')')) {
    return splitTopLevel(term.slice(4, -1)).every((sub) => matchesTerm(row, sub))
  }
  const firstDot = term.indexOf('.')
  const secondDot = term.indexOf('.', firstDot + 1)
  if (firstDot === -1 || secondDot === -1) {
    throw new Error(`in-memory PostgREST: unsupported filter term "${term}"`)
  }
  const column = term.slice(0, firstDot)
  const operator = term.slice(firstDot + 1, secondDot)
  const value = term.slice(secondDot + 1)
  const delta = cmp(row[column], value)
  switch (operator) {
    case 'lt':
      return delta < 0
    case 'lte':
      return delta <= 0
    case 'gt':
      return delta > 0
    case 'gte':
      return delta >= 0
    case 'eq':
      return delta === 0
    case 'neq':
      return delta !== 0
    default:
      throw new Error(`in-memory PostgREST: unsupported operator "${operator}" in "${term}"`)
  }
}

function makeKeysetSupabase(tables: Record<string, Row[]>) {
  const from = vi.fn((table: string) => {
    let rows = [...(tables[table] ?? [])]
    const orders: Array<{ column: string; ascending: boolean }> = []
    let limitValue: number | null = null
    let singleRow = false

    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        rows = rows.filter((r) => cmp(r[column], value) === 0)
        return builder
      },
      neq: (column: string, value: unknown) => {
        rows = rows.filter((r) => cmp(r[column], value) !== 0)
        return builder
      },
      gte: (column: string, value: unknown) => {
        rows = rows.filter((r) => cmp(r[column], value) >= 0)
        return builder
      },
      lte: (column: string, value: unknown) => {
        rows = rows.filter((r) => cmp(r[column], value) <= 0)
        return builder
      },
      is: (column: string, value: unknown) => {
        rows = rows.filter((r) => (r[column] ?? null) === value)
        return builder
      },
      not: (column: string, operator: string, value: unknown) => {
        if (operator !== 'is') {
          throw new Error(`in-memory PostgREST: unsupported not() operator "${operator}"`)
        }
        rows = rows.filter((r) => (r[column] ?? null) !== value)
        return builder
      },
      or: (expression: string) => {
        const terms = splitTopLevel(expression)
        rows = rows.filter((r) => terms.some((term) => matchesTerm(r, term)))
        return builder
      },
      order: (column: string, options?: { ascending?: boolean }) => {
        orders.push({ column, ascending: options?.ascending !== false })
        return builder
      },
      limit: (count: number) => {
        limitValue = count
        return builder
      },
      maybeSingle: () => {
        singleRow = true
        return builder
      },
      single: () => {
        singleRow = true
        return builder
      },
      then: (resolve: (value: unknown) => void) => {
        const sorted = [...rows].sort((a, b) => {
          for (const o of orders) {
            const delta = cmp(a[o.column], b[o.column])
            if (delta !== 0) return o.ascending ? delta : -delta
          }
          return 0
        })
        const sliced = limitValue === null ? sorted : sorted.slice(0, limitValue)
        resolve(singleRow ? { data: sliced[0] ?? null, error: null } : { data: sliced, error: null })
      },
    }
    return builder
  })

  return { from, rpc: vi.fn(async () => ({ data: null, error: null })) }
}

// ──────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CUSTOMER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SUPPLIER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const FISCAL_PERIOD_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const USER_ID = 'user-1'

// Ascending lexical order, which is also the id tie-break order.
const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
  '77777777-7777-4777-8777-777777777777',
]

// Rows 3 and 4 deliberately share a created_at so the id tie-break is
// exercised at a page boundary (limit=2 splits the pair across pages 2/3).
const CREATED_AT = [
  '2026-07-25T10:00:06.000Z',
  '2026-07-25T10:00:05.000Z',
  '2026-07-25T10:00:04.000Z',
  '2026-07-25T10:00:03.000Z',
  '2026-07-25T10:00:03.000Z',
  '2026-07-25T10:00:02.000Z',
  '2026-07-25T10:00:01.000Z',
]

// Every row carries the SAME business date: this is the bulk-import shape
// that made the old date-anchored cursor loop forever.
const BUSINESS_DATE = '2026-07-25'

/** Expected read order under (created_at DESC, id ASC). */
const EXPECTED_ORDER = IDS

const MEMBERSHIP = [{ user_id: USER_ID, company_id: COMPANY_ID, role: 'owner' }]

function invoiceRows(): Row[] {
  return IDS.map((id, i) => ({
    id,
    company_id: COMPANY_ID,
    invoice_number: `F-10${i}`,
    customer_id: CUSTOMER_ID,
    invoice_date: BUSINESS_DATE,
    due_date: '2026-08-24',
    status: 'sent',
    document_type: 'invoice',
    currency: 'SEK',
    subtotal: 1000,
    vat_amount: 250,
    total: 1250,
    remaining_amount: 1250,
    paid_at: null,
    created_at: CREATED_AT[i],
    customer: { id: CUSTOMER_ID, name: 'Acme AB' },
  }))
}

function journalEntryRows(): Row[] {
  return IDS.map((id, i) => ({
    id,
    company_id: COMPANY_ID,
    fiscal_period_id: FISCAL_PERIOD_ID,
    voucher_series: 'A',
    voucher_number: 100 + i,
    entry_date: BUSINESS_DATE,
    description: `Verifikat ${100 + i}`,
    status: 'posted',
    source_type: 'manual',
    source_id: null,
    notes: null,
    reverses_id: null,
    reversed_by_id: null,
    correction_of_id: null,
    created_at: CREATED_AT[i],
    updated_at: CREATED_AT[i],
  }))
}

function supplierInvoiceRows(): Row[] {
  return IDS.map((id, i) => ({
    id,
    company_id: COMPANY_ID,
    supplier_id: SUPPLIER_ID,
    arrival_number: 40 + i,
    supplier_invoice_number: `2026-12${i}`,
    invoice_date: BUSINESS_DATE,
    due_date: '2026-08-24',
    status: 'registered',
    currency: 'SEK',
    subtotal: 1000,
    vat_amount: 250,
    total: 1250,
    paid_amount: 0,
    remaining_amount: 1250,
    is_credit_note: false,
    paid_at: null,
    created_at: CREATED_AT[i],
    supplier: { id: SUPPLIER_ID, name: 'Office Depot AB' },
  }))
}

function transactionRows(): Row[] {
  return IDS.map((id, i) => ({
    id,
    company_id: COMPANY_ID,
    date: BUSINESS_DATE,
    description: `Kortköp ${i}`,
    amount: -100 - i,
    currency: 'SEK',
    reference: null,
    merchant_name: null,
    journal_entry_id: null,
    invoice_id: null,
    supplier_invoice_id: null,
    is_business: null,
    category: null,
    import_source: 'csv',
    created_at: CREATED_AT[i],
  }))
}

// ──────────────────────────────────────────────────────────────────
// Endpoint table
// ──────────────────────────────────────────────────────────────────

type ListHandler = (
  request: Request,
  params: { params: Promise<{ companyId: string }> },
) => Promise<Response>

interface ListEndpointCase {
  name: string
  segment: string
  table: string
  scope: string
  handler: ListHandler
  rows: () => Row[]
  /** A query string that must fail validation with 400. */
  invalidQuery: string
}

const ENDPOINTS: ListEndpointCase[] = [
  {
    name: 'invoices',
    segment: 'invoices',
    table: 'invoices',
    scope: 'invoices:read',
    handler: listInvoices as ListHandler,
    rows: invoiceRows,
    invalidQuery: 'status=quantum',
  },
  {
    name: 'journal-entries',
    segment: 'journal-entries',
    table: 'journal_entries',
    scope: 'reports:read',
    handler: listJournalEntries as ListHandler,
    rows: journalEntryRows,
    invalidQuery: 'status=quantum',
  },
  {
    name: 'supplier-invoices',
    segment: 'supplier-invoices',
    table: 'supplier_invoices',
    scope: 'suppliers:read',
    handler: listSupplierInvoices as ListHandler,
    rows: supplierInvoiceRows,
    invalidQuery: 'date_from=2026/07/25',
  },
  {
    name: 'transactions',
    segment: 'transactions',
    table: 'transactions',
    scope: 'transactions:read',
    handler: listTransactions as ListHandler,
    rows: transactionRows,
    invalidQuery: 'status=unknown',
  },
]

const ALL_SCOPES = ENDPOINTS.map((e) => e.scope)

function makeRequest(url: string, withAuth = true): Request {
  return new Request(url, {
    method: 'GET',
    headers: withAuth ? { Authorization: 'Bearer test-fixture-not-a-real-key' } : {},
  })
}

function companyParams(companyId: string) {
  return { params: Promise.resolve({ companyId }) }
}

interface Page {
  ids: string[]
  nextCursor: string | undefined
}

async function fetchPage(
  endpoint: ListEndpointCase,
  query: string,
): Promise<{ status: number; page: Page; body: { data: Array<{ id: string }>; meta: { next_cursor?: string } } }> {
  const res = await endpoint.handler(
    makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/${endpoint.segment}?${query}`),
    companyParams(COMPANY_ID),
  )
  const body = await res.json()
  return {
    status: res.status,
    body,
    page: {
      ids: (body.data ?? []).map((row: { id: string }) => row.id),
      nextCursor: body.meta?.next_cursor,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ALL_SCOPES,
    mode: 'live',
  })
})

// ──────────────────────────────────────────────────────────────────
// The decisive tests
// ──────────────────────────────────────────────────────────────────

describe.each(ENDPOINTS)('GET /api/v1/companies/:companyId/$name cursor pagination', (endpoint) => {
  function mountRows() {
    mockServiceClient.mockReturnValue(
      makeKeysetSupabase({
        company_members: MEMBERSHIP,
        [endpoint.table]: endpoint.rows(),
      }),
    )
  }

  it('page 2 shares zero ids with page 1', async () => {
    mountRows()
    const first = await fetchPage(endpoint, 'limit=2')
    expect(first.status).toBe(200)
    expect(first.page.ids).toHaveLength(2)
    expect(first.page.nextCursor).toBeTruthy()

    const second = await fetchPage(endpoint, `limit=2&cursor=${encodeURIComponent(first.page.nextCursor!)}`)
    expect(second.status).toBe(200)
    expect(second.page.ids).toHaveLength(2)

    const overlap = second.page.ids.filter((id) => first.page.ids.includes(id))
    expect(overlap).toEqual([])
  })

  it('the emitted cursor is a decodable (timestamp, uuid) pair', async () => {
    mountRows()
    const first = await fetchPage(endpoint, 'limit=2')
    // The whole bug was an encoder/decoder mismatch: a cursor that the
    // route's own decoder throws away silently disables the keyset.
    const decoded = decodeDefaultCursor(first.page.nextCursor!)
    expect(decoded).not.toBeNull()
    expect(decoded!.id).toBe(first.page.ids[first.page.ids.length - 1])
  })

  it('walks every row exactly once and terminates', async () => {
    mountRows()
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0

    // Hard stop well above the 4 pages this fixture needs: an unterminated
    // walk fails the assertion below instead of hanging CI.
    while (pages < 20) {
      pages++
      const query = cursor ? `limit=2&cursor=${encodeURIComponent(cursor)}` : 'limit=2'
      const { status, page } = await fetchPage(endpoint, query)
      expect(status).toBe(200)
      seen.push(...page.ids)
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }

    expect(pages).toBe(4) // 7 rows at limit=2
    expect(seen).toEqual(EXPECTED_ORDER)
    expect(new Set(seen).size).toBe(EXPECTED_ORDER.length)
  })

  it('breaks created_at ties on id so a tied pair is not re-served', async () => {
    mountRows()
    // Rows 3 and 4 share a created_at. Page 2 ends on row 3; page 3 must
    // start on row 4 rather than repeating the tied timestamp block.
    const first = await fetchPage(endpoint, 'limit=2')
    const second = await fetchPage(endpoint, `limit=2&cursor=${encodeURIComponent(first.page.nextCursor!)}`)
    expect(second.page.ids).toEqual([IDS[2], IDS[3]])
    const third = await fetchPage(endpoint, `limit=2&cursor=${encodeURIComponent(second.page.nextCursor!)}`)
    expect(third.page.ids).toEqual([IDS[4], IDS[5]])
  })

  it('does not advertise a next_cursor on the final page', async () => {
    mountRows()
    const { page } = await fetchPage(endpoint, 'limit=100')
    expect(page.ids).toEqual(EXPECTED_ORDER)
    expect(page.nextCursor).toBeUndefined()
  })

  it('fails soft on a tampered cursor: restarts at page 1 with 200', async () => {
    // pagination.ts documents the contract at its ISO_TIMESTAMP guard: a
    // stale or corrupt cursor is discarded and treated as "start from the
    // beginning", never a 400.
    const garbage = [
      'not-base64-or-json',
      Buffer.from(JSON.stringify({ ts: '2026-07-25', id: IDS[0] })).toString('base64url'),
      Buffer.from(JSON.stringify({ ts: '2026-07-25T10:00:03.000Z', id: 'not-a-uuid' })).toString('base64url'),
      Buffer.from(JSON.stringify({ ts: "'); drop table api_keys; --", id: IDS[0] })).toString('base64url'),
    ]

    for (const cursor of garbage) {
      mountRows()
      const { status, page } = await fetchPage(endpoint, `limit=2&cursor=${encodeURIComponent(cursor)}`)
      expect(status).toBe(200)
      expect(page.ids).toEqual([IDS[0], IDS[1]])
    }
  })

  it('orders by created_at, not by the business date column', async () => {
    // Every fixture row shares the same invoice_date / entry_date / date.
    // A date-anchored sort cannot produce a stable total order here, which
    // is exactly how the P0 manifested in production.
    mountRows()
    const { body } = await fetchPage(endpoint, 'limit=100')
    const timestamps = body.data.map((row) => (row as unknown as { created_at: string }).created_at)
    const descending = [...timestamps].sort().reverse()
    expect(timestamps).toEqual(descending)
  })
})

// ──────────────────────────────────────────────────────────────────
// Standard route guards
// ──────────────────────────────────────────────────────────────────

describe.each(ENDPOINTS)('GET /api/v1/companies/:companyId/$name guards', (endpoint) => {
  it('returns 401 UNAUTHORIZED without a bearer token', async () => {
    mockServiceClient.mockReturnValue(makeKeysetSupabase({}))
    const res = await endpoint.handler(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/${endpoint.segment}`, false),
      companyParams(COMPANY_ID),
    )
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('returns 400 VALIDATION_ERROR on a malformed filter', async () => {
    mockServiceClient.mockReturnValue(makeKeysetSupabase({ company_members: MEMBERSHIP }))
    const { status, body } = await fetchPage(endpoint, endpoint.invalidQuery)
    expect(status).toBe(400)
    expect((body as unknown as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 NOT_FOUND when the key user is not a member of the company', async () => {
    // No company_members row: the wrapper 404s rather than leaking existence.
    mockServiceClient.mockReturnValue(
      makeKeysetSupabase({ company_members: [], [endpoint.table]: endpoint.rows() }),
    )
    const { status, body } = await fetchPage(endpoint, 'limit=2')
    expect(status).toBe(404)
    expect((body as unknown as { error: { code: string } }).error.code).toBe('NOT_FOUND')
  })

  it('returns 403 INSUFFICIENT_SCOPE when the key lacks the read scope', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      scopes: ALL_SCOPES.filter((s) => s !== endpoint.scope),
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeKeysetSupabase({ company_members: MEMBERSHIP }))
    const { status, body } = await fetchPage(endpoint, 'limit=2')
    expect(status).toBe(403)
    expect((body as unknown as { error: { code: string } }).error.code).toBe('INSUFFICIENT_SCOPE')
  })
})

// ──────────────────────────────────────────────────────────────────
// Business-date filters stay available now that the sort key moved
// ──────────────────────────────────────────────────────────────────

describe('business-date filters', () => {
  it('invoices: ?date_from / ?date_to narrow on invoice_date', async () => {
    const rows = invoiceRows()
    rows[0].invoice_date = '2026-01-15'
    mockServiceClient.mockReturnValue(
      makeKeysetSupabase({ company_members: MEMBERSHIP, invoices: rows }),
    )
    const { status, page } = await fetchPage(ENDPOINTS[0], 'limit=100&date_from=2026-07-01&date_to=2026-07-31')
    expect(status).toBe(200)
    expect(page.ids).toEqual(EXPECTED_ORDER.slice(1))
  })

  it('journal-entries: ?date_from / ?date_to narrow on entry_date', async () => {
    const rows = journalEntryRows()
    rows[0].entry_date = '2026-01-15'
    mockServiceClient.mockReturnValue(
      makeKeysetSupabase({ company_members: MEMBERSHIP, journal_entries: rows }),
    )
    const { status, page } = await fetchPage(ENDPOINTS[1], 'limit=100&date_from=2026-07-01&date_to=2026-07-31')
    expect(status).toBe(200)
    expect(page.ids).toEqual(EXPECTED_ORDER.slice(1))
  })

  it('supplier-invoices: ?date_from / ?date_to narrow on invoice_date', async () => {
    const rows = supplierInvoiceRows()
    rows[0].invoice_date = '2026-01-15'
    mockServiceClient.mockReturnValue(
      makeKeysetSupabase({ company_members: MEMBERSHIP, supplier_invoices: rows }),
    )
    const { status, page } = await fetchPage(ENDPOINTS[2], 'limit=100&date_from=2026-07-01&date_to=2026-07-31')
    expect(status).toBe(200)
    expect(page.ids).toEqual(EXPECTED_ORDER.slice(1))
  })

  it('transactions: ?date_from / ?date_to narrow on date', async () => {
    const rows = transactionRows()
    rows[0].date = '2026-01-15'
    mockServiceClient.mockReturnValue(
      makeKeysetSupabase({ company_members: MEMBERSHIP, transactions: rows }),
    )
    const { status, page } = await fetchPage(ENDPOINTS[3], 'limit=100&date_from=2026-07-01&date_to=2026-07-31')
    expect(status).toBe(200)
    expect(page.ids).toEqual(EXPECTED_ORDER.slice(1))
  })
})
