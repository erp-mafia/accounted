/**
 * The purchase category through the v1 door:
 *   GET /api/v1/companies/:companyId/inbox-items/:id   carries purchase_category
 *   PUT /api/v1/companies/:companyId/inbox-items/:id/purchase-category
 *
 * Rules are the services' (lib/documents/inbox-purchase-category.ts, the
 * read side lib/categories/inbox-purchase-category.ts), shared with the
 * dashboard route.
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
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }), isMembershipDormant: () => false }
})
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase } from '@/tests/helpers'
import { GET as getItem } from '../[id]/route'
import { PUT as putCategory } from '../[id]/purchase-category/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

type TableAnswer = { data?: unknown; error?: unknown }

/** The shared per-table mock, keyed by table: each value is one answer or a queue. */
function makeClient(byTable: Record<string, TableAnswer | TableAnswer[]>) {
  const mock = createTableMockSupabase(byTable)
  return { ...mock.supabase, calls: mock.calls }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ITEM_ID = '22222222-2222-4222-8222-222222222222'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/inbox-items`
const itemParams = (id = ITEM_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })

function request(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
  })
}

const READING = {
  documentKind: 'supplier_invoice',
  supplier: { name: 'Telia Company AB' },
  invoice: { invoiceNumber: 'F-1', invoiceDate: '2026-09-01', currency: 'SEK' },
  totals: { total: 499 },
  lineItems: [],
  vatBreakdown: [],
  confidence: 0.9,
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    status: 'received',
    source: 'email',
    created_at: '2026-09-02T07:41:10.000Z',
    updated_at: '2026-09-02T07:41:30.000Z',
    document_id: null,
    extracted_data: READING,
    extraction_skipped: false,
    matched_supplier_id: null,
    matched_transaction_id: null,
    created_supplier_invoice_id: null,
    created_journal_entry_id: null,
    email_from: null,
    email_subject: null,
    email_received_at: null,
    email_body_text: null,
    error_message: null,
    kind_hint: null,
    ...overrides,
  }
}

const TELIA_TEMPLATE = {
  counterparty_name: 'telia company',
  counterparty_aliases: [],
  debit_account: '6212',
  credit_account: '1930',
  line_pattern: null,
  occurrence_count: 11,
  corrections: 1,
  source: 'auto_learned',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['documents:read', 'documents:write'],
    mode: 'live',
  })
})

describe('GET /inbox-items/:id purchase_category', () => {
  it('proposes from the counterparty\'s booked history', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        invoice_inbox_items: { data: itemRow(), error: null },
        categorization_templates: [{ data: [TELIA_TEMPLATE], error: null }, { data: [], error: null }],
      }),
    )
    const res = await getItem(request(`${BASE}/${ITEM_ID}`, { method: 'GET' }), itemParams())
    expect(res.status).toBe(200)
    expect((await res.json()).data.purchase_category).toEqual({
      code: 'expense.telecom.mobile',
      source: 'counterparty',
      level: 'Stark',
      version: 'pc-2026-10',
    })
  })

  it('answers null when nothing points anywhere', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: MEMBER, invoice_inbox_items: { data: itemRow(), error: null } }),
    )
    const res = await getItem(request(`${BASE}/${ITEM_ID}`, { method: 'GET' }), itemParams())
    expect((await res.json()).data.purchase_category).toBeNull()
  })
})

describe('PUT /inbox-items/:id/purchase-category', () => {
  const put = (body: unknown, query = '') =>
    putCategory(
      request(`${BASE}/${ITEM_ID}/purchase-category${query}`, { method: 'PUT', body: JSON.stringify(body) }),
      itemParams(),
    )

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await put({ code: 'expense.equipment.hardware' })).status).toBe(401)
  })

  it('403 without documents:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['documents:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await put({ code: 'expense.equipment.hardware' })).status).toBe(403)
  })

  it('400 for a code outside the taxonomy or a missing code', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await put({ code: 'hardware' })).status).toBe(400)
    expect((await put({})).status).toBe(400)
  })

  it('404 INBOX_ITEM_NOT_FOUND outside the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, invoice_inbox_items: { data: null, error: null } }))
    const res = await put({ code: 'expense.equipment.hardware' })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('INBOX_ITEM_NOT_FOUND')
  })

  it('409 INBOX_ITEM_NO_READING for an item without a reading of its own', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: MEMBER, invoice_inbox_items: { data: itemRow({ extracted_data: null }), error: null } }),
    )
    const res = await put({ code: 'expense.equipment.hardware' })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('INBOX_ITEM_NO_READING')
  })

  it('stores the choice as the API\'s and answers it as Ditt val', async () => {
    const client = makeClient({
      company_members: MEMBER,
      invoice_inbox_items: [{ data: itemRow(), error: null }, { data: { id: ITEM_ID }, error: null }],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await put({ code: 'expense.telecom.landline' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      inbox_item_id: ITEM_ID,
      purchase_category: { code: 'expense.telecom.landline', source: 'person', level: 'Ditt val', version: 'pc-2026-10' },
    })
    const update = client.calls.find((c) => c.table === 'invoice_inbox_items' && c.method === 'update')
    expect(update?.args[0]).toMatchObject({
      extracted_data: { ...READING, purchaseCategory: { code: 'expense.telecom.landline', source: 'person', set_via: 'api' } },
    })
  })

  it('a dry run writes nothing', async () => {
    const client = makeClient({ company_members: MEMBER, invoice_inbox_items: { data: itemRow(), error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await put({ code: 'expense.telecom.landline' }, '?dry_run=true')
    expect(res.status).toBe(200)
    expect(client.calls.some((c) => c.table === 'invoice_inbox_items' && c.method === 'update')).toBe(false)
  })

  it('every_time on an item without a matched supplier is 409 INBOX_ITEM_NO_SUPPLIER and writes nothing', async () => {
    const client = makeClient({ company_members: MEMBER, invoice_inbox_items: { data: itemRow(), error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await put({ code: 'expense.telecom.landline', every_time: true })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('INBOX_ITEM_NO_SUPPLIER')
    expect(client.calls.some((c) => c.method === 'update')).toBe(false)
  })

  it('400 for an every_time that is not a boolean', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await put({ code: 'expense.telecom.landline', every_time: 'yes' })).status).toBe(400)
  })

  it('every_time makes the choice the matched supplier\'s instruction, scoped to the company', async () => {
    const SUPPLIER = '33333333-3333-4333-8333-333333333333'
    const client = makeClient({
      company_members: MEMBER,
      invoice_inbox_items: [{ data: itemRow({ matched_supplier_id: SUPPLIER }), error: null }, { data: { id: ITEM_ID }, error: null }],
      suppliers: [
        { data: { id: SUPPLIER }, error: null },
        { data: [{ id: SUPPLIER, default_expense_account: null, default_purchase_category: 'expense.telecom.landline' }], error: null },
      ],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await put({ code: 'expense.telecom.landline', every_time: true })
    expect(res.status).toBe(200)
    expect((await res.json()).data.purchase_category).toMatchObject({ code: 'expense.telecom.landline', source: 'person', level: 'Ditt val' })
    const update = client.calls.find((c) => c.table === 'suppliers' && c.method === 'update')
    expect(update?.args[0]).toEqual({ default_purchase_category: 'expense.telecom.landline' })
    const scoped = client.calls.filter((c) => c.table === 'suppliers' && c.method === 'eq').map((c) => c.args)
    expect(scoped).toContainEqual(['company_id', COMPANY_ID])
  })
})

describe('GET /inbox-items/:id purchase_category from a supplier instruction', () => {
  it('reads the matched supplier\'s instruction as Ditt val over the booked history', async () => {
    const SUPPLIER = '33333333-3333-4333-8333-333333333333'
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        invoice_inbox_items: { data: itemRow({ matched_supplier_id: SUPPLIER }), error: null },
        categorization_templates: [{ data: [TELIA_TEMPLATE], error: null }, { data: [], error: null }],
        suppliers: { data: [{ id: SUPPLIER, default_expense_account: '6212', default_purchase_category: 'expense.telecom.internet' }], error: null },
      }),
    )
    const res = await getItem(request(`${BASE}/${ITEM_ID}`, { method: 'GET' }), itemParams())
    expect(res.status).toBe(200)
    expect((await res.json()).data.purchase_category).toEqual({
      code: 'expense.telecom.internet',
      source: 'instruction',
      level: 'Ditt val',
      version: 'pc-2026-10',
    })
  })
})
