/**
 * The invoice inbox through the v1 door of the operation registry
 * (src/lib/operations/inbox-items.ts via lib/operations/v1.ts):
 *   GET    /api/v1/companies/:companyId/inbox-items
 *   GET    /api/v1/companies/:companyId/inbox-items/:id
 *   PATCH  /api/v1/companies/:companyId/inbox-items/:id
 *   DELETE /api/v1/companies/:companyId/inbox-items/:id
 *   POST   /api/v1/companies/:companyId/inbox-items/:id/unmatch-transaction
 *   POST   /api/v1/companies/:companyId/inbox-items/:id/convert
 *
 * The rules are the services' (lib/documents/inbox-item-actions.ts,
 * lib/documents/inbox-convert.ts), shared with the extension's dashboard
 * routes: converted items are frozen, booked ones cannot be discarded, the
 * list carries no e-mail body or full reading, and a dry run writes nothing
 * (for convert: no ankomstnummer either).
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
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
  createSupplierInvoiceRegistrationEntry: vi.fn().mockResolvedValue({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createSupplierInvoiceRegistrationEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { GET as listItems } from '../route'
import { GET as getItem, PATCH as patchItem, DELETE as deleteItem } from '../[id]/route'
import { POST as unmatch } from '../[id]/unmatch-transaction/route'
import { POST as convert } from '../[id]/convert/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
}

/** Per-table queue mock that also records every (table, method, args). */
function makeClient(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
  for (const [t, val] of Object.entries(byTable)) queues.set(t, Array.isArray(val) ? [...val] : [val])
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const buildChain = (key: string): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => {
              const q = queues.get(key)
              resolve(q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null }))
            }
          }
          return (...args: unknown[]) => {
            calls.push({ table: key, method: String(prop), args })
            return buildChain(key)
          }
        },
      },
    )
  const rpc = vi.fn((...args: unknown[]) => {
    calls.push({ table: 'rpc', method: 'rpc', args })
    return buildChain('rpc')
  })
  const storage = { from: vi.fn(() => buildChain('storage')) }
  return { calls, from: vi.fn((table: string) => buildChain(table)), rpc, storage }
}

const WRITES = new Set(['insert', 'update', 'upsert', 'delete', 'remove'])
/** Business tables only: withApiV1's own bookkeeping (idempotency, usage) is not the operation's. */
const BOOKS = new Set(['document_attachments', 'transactions', 'invoice_inbox_items', 'supplier_invoices', 'supplier_invoice_items', 'suppliers', 'processing_history'])
const wrote = (client: ReturnType<typeof makeClient>) =>
  client.calls.some((c) => (BOOKS.has(c.table) && WRITES.has(c.method)) || c.method === 'rpc')

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ITEM_ID = '22222222-2222-4222-8222-222222222222'
const DOC_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const TX_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const SUPPLIER_ID = '33333333-3333-4333-8333-333333333333'
const INVOICE_ID = '44444444-4444-4444-8444-444444444444'
const JE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/inbox-items`

function request(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  })
}

const companyParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }
const itemParams = (id = ITEM_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })

const READING = {
  supplier: { name: 'Clas Ohlson AB', orgNumber: '556035-8672' },
  invoice: { invoiceNumber: 'F-1', invoiceDate: '2026-09-01', currency: 'SEK' },
  totals: { subtotal: 399.2, vatAmount: 99.8, total: 499 },
  lineItems: [{ description: 'Kabel' }],
  vatBreakdown: [],
  confidence: 0.9,
  documentKind: 'receipt',
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    status: 'received',
    source: 'email',
    created_at: '2026-09-02T07:41:10.000Z',
    updated_at: '2026-09-02T07:41:30.000Z',
    document_id: DOC_ID,
    extracted_data: READING,
    extraction_skipped: false,
    matched_supplier_id: null,
    matched_transaction_id: null,
    created_supplier_invoice_id: null,
    created_journal_entry_id: null,
    email_from: 'kvitto@clasohlson.se',
    email_subject: 'Ditt kvitto',
    email_received_at: '2026-09-02T07:41:02.000Z',
    email_body_text: 'Hej Anna, tack för ditt köp',
    error_message: null,
    kind_hint: null,
    channel_context: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['documents:read', 'documents:write', 'suppliers:write'],
    mode: 'live',
  })
})

describe('GET /inbox-items', () => {
  const get = (query = '') => listItems(request(`${BASE}${query}`, { method: 'GET' }), companyParams)

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await get()).status).toBe(401)
  })

  it('403 without documents:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await get()).status).toBe(403)
  })

  it('400 on an unknown status', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await get('?status=booked')).status).toBe(400)
  })

  it('summarises the reading and leaves the e-mail body and full reading out', async () => {
    const client = makeClient({ company_members: MEMBER, invoice_inbox_items: { data: [itemRow()], error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await get('?unprocessed_only=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.next_cursor).toBeNull()
    expect(body.data.inbox_items[0]).toMatchObject({
      inbox_item_id: ITEM_ID,
      vendor_name: 'Clas Ohlson AB',
      amount: 499,
      currency: 'SEK',
      invoice_date: '2026-09-01',
      processed: false,
    })
    expect(body.data.inbox_items[0].email_body_text).toBeUndefined()
    expect(body.data.inbox_items[0].extracted_data).toBeUndefined()
    const itemCalls = client.calls.filter((c) => c.table === 'invoice_inbox_items')
    expect(itemCalls).toContainEqual(expect.objectContaining({ method: 'is', args: ['created_supplier_invoice_id', null] }))
  })
})

describe('GET /inbox-items/:id', () => {
  const get = (id = ITEM_ID) => getItem(request(`${BASE}/${id}`, { method: 'GET' }), itemParams(id))

  it('400 on a non-UUID id', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await get('nope')).status).toBe(400)
  })

  it('404 INBOX_ITEM_NOT_FOUND outside the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, invoice_inbox_items: { data: null, error: null } }))
    const res = await get()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('INBOX_ITEM_NOT_FOUND')
  })

  it('answers the full reading, the e-mail text and the file name', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        invoice_inbox_items: { data: itemRow(), error: null },
        document_attachments: { data: { id: DOC_ID, file_name: 'kvitto.pdf', extracted_data: null }, error: null },
      }),
    )
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({
      inbox_item_id: ITEM_ID,
      file_name: 'kvitto.pdf',
      email_body_text: 'Hej Anna, tack för ditt köp',
      extracted_data: { documentKind: 'receipt' },
    })
  })
})

describe('PATCH /inbox-items/:id', () => {
  const patch = (body: unknown, query = '') =>
    patchItem(request(`${BASE}/${ITEM_ID}${query}`, { method: 'PATCH', body: JSON.stringify(body) }), itemParams())

  it('403 without documents:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['documents:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await patch({ totals: { total: 500 } })).status).toBe(403)
  })

  it('400 for an empty body or a malformed date', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await patch({})).status).toBe(400)
    expect((await patch({ invoice: { invoiceDate: '2026-13-01' } })).status).toBe(400)
  })

  it('409 INBOX_ITEM_EDIT_LOCKED once converted, writing nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      invoice_inbox_items: { data: itemRow({ created_supplier_invoice_id: INVOICE_ID }), error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await patch({ totals: { total: 500 } })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('INBOX_ITEM_EDIT_LOCKED')
    expect(wrote(client)).toBe(false)
  })

  it('a dry run previews the merged reading and writes nothing', async () => {
    const client = makeClient({ company_members: MEMBER, invoice_inbox_items: { data: itemRow(), error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await patch({ totals: { total: 500 } }, '?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview.extracted_data).toMatchObject({ totals: { total: 500, subtotal: 399.2 }, documentKind: 'receipt' })
    expect(wrote(client)).toBe(false)
  })

  it('merges the correction (keeping unnamed fields) under optimistic concurrency', async () => {
    const client = makeClient({
      company_members: MEMBER,
      invoice_inbox_items: [
        { data: itemRow(), error: null },
        { data: { id: ITEM_ID, extracted_data: { ...READING, totals: { ...READING.totals, total: 500 } } }, error: null },
      ],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await patch({ totals: { total: 500 } })
    expect(res.status).toBe(200)
    expect((await res.json()).data.inbox_item_id).toBe(ITEM_ID)
    const update = client.calls.find((c) => c.table === 'invoice_inbox_items' && c.method === 'update')
    expect(update?.args[0]).toMatchObject({ extracted_data: { documentKind: 'receipt', totalSource: null, totals: { total: 500 } } })
    expect(client.calls).toContainEqual(
      expect.objectContaining({ table: 'invoice_inbox_items', method: 'eq', args: ['updated_at', '2026-09-02T07:41:30.000Z'] }),
    )
  })

  it('409 INBOX_ITEM_EDIT_CONFLICT when the row moved under the edit', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: MEMBER, invoice_inbox_items: [{ data: itemRow(), error: null }, { data: null, error: null }] }),
    )
    const res = await patch({ totals: { total: 500 } })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('INBOX_ITEM_EDIT_CONFLICT')
  })
})

describe('DELETE /inbox-items/:id', () => {
  const del = (query = '') => deleteItem(request(`${BASE}/${ITEM_ID}${query}`, { method: 'DELETE' }), itemParams())

  it('404 outside the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, invoice_inbox_items: { data: null, error: null } }))
    expect((await del()).status).toBe(404)
  })

  it('409 for a converted item and for a booked one, writing nothing', async () => {
    const converted = makeClient({ company_members: MEMBER, invoice_inbox_items: { data: itemRow({ created_supplier_invoice_id: INVOICE_ID }), error: null } })
    mockServiceClient.mockReturnValue(converted)
    const a = await del()
    expect(a.status).toBe(409)
    expect((await a.json()).error.code).toBe('INBOX_ITEM_DELETE_CONVERTED')
    expect(wrote(converted)).toBe(false)

    const booked = makeClient({ company_members: MEMBER, invoice_inbox_items: { data: itemRow({ created_journal_entry_id: JE_ID }), error: null } })
    mockServiceClient.mockReturnValue(booked)
    const b = await del()
    expect(b.status).toBe(409)
    expect((await b.json()).error.code).toBe('INBOX_ITEM_DELETE_BOOKED')
    expect(wrote(booked)).toBe(false)
  })

  it('a dry run writes nothing; the commit deletes the item only', async () => {
    const dry = makeClient({ company_members: MEMBER, invoice_inbox_items: { data: itemRow(), error: null } })
    mockServiceClient.mockReturnValue(dry)
    const preview = await del('?dry_run=true')
    expect(preview.status).toBe(200)
    expect((await preview.json()).data.preview).toEqual({ inbox_item_id: ITEM_ID, document_id: DOC_ID, would_delete: true })
    expect(wrote(dry)).toBe(false)

    const client = makeClient({ company_members: MEMBER, invoice_inbox_items: [{ data: itemRow(), error: null }, { data: null, error: null }] })
    mockServiceClient.mockReturnValue(client)
    const res = await del()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ inbox_item_id: ITEM_ID, deleted: true })
    const writes = client.calls
      .filter((c) => BOOKS.has(c.table) && WRITES.has(c.method))
      .map((c) => `${c.table}.${c.method}`)
    expect(writes).toEqual(['invoice_inbox_items.delete'])
  })
})

describe('POST /inbox-items/:id/unmatch-transaction', () => {
  const post = (query = '') => unmatch(request(`${BASE}/${ITEM_ID}/unmatch-transaction${query}`, { method: 'POST' }), itemParams())

  it('404 outside the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, invoice_inbox_items: { data: null, error: null } }))
    const res = await post()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('INBOX_ITEM_NOT_FOUND')
  })

  it('a dry run writes nothing', async () => {
    const client = makeClient({ company_members: MEMBER, invoice_inbox_items: { data: itemRow({ matched_transaction_id: TX_ID }), error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await post('?dry_run=true')
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toEqual({
      inbox_item_id: ITEM_ID,
      released_transaction_id: TX_ID,
      clears_transaction_document: true,
    })
    expect(wrote(client)).toBe(false)
  })

  it('releases the match and clears the pin only while it is still this item\'s document', async () => {
    const client = makeClient({ company_members: MEMBER, invoice_inbox_items: { data: itemRow({ matched_transaction_id: TX_ID }), error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ inbox_item_id: ITEM_ID, matched_transaction_id: null, released_transaction_id: TX_ID })
    expect(client.calls).toContainEqual(expect.objectContaining({ table: 'transactions', method: 'update', args: [{ document_id: null }] }))
    expect(client.calls).toContainEqual(expect.objectContaining({ table: 'transactions', method: 'eq', args: ['document_id', DOC_ID] }))
  })
})

describe('POST /inbox-items/:id/convert', () => {
  const BODY = {
    supplier_id: SUPPLIER_ID,
    supplier_invoice_number: 'F-1',
    invoice_date: '2026-09-01',
    due_date: '2026-09-30',
    items: [{ description: 'Kabel', amount: 399.2, account_number: '6110', vat_rate: 0.25 }],
  }
  const post = (body: unknown, query = '') =>
    convert(request(`${BASE}/${ITEM_ID}/convert${query}`, { method: 'POST', body: JSON.stringify(body) }), itemParams())

  it('403 without suppliers:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['documents:write'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await post(BODY)).status).toBe(403)
  })

  it('400 for a field the conversion does not honour, and for a line contradicting the VAT treatment', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const dropped = await post({ ...BODY, items: [{ ...BODY.items[0], vat_amount: 50 }] })
    expect(dropped.status).toBe(400)
    const exempt = await post({ ...BODY, vat_treatment: 'exempt' })
    expect(exempt.status).toBe(400)
    expect((await exempt.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('404 for an item or a supplier outside the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, invoice_inbox_items: { data: null, error: null } }))
    expect((await post(BODY)).status).toBe(404)
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: MEMBER, invoice_inbox_items: { data: itemRow(), error: null }, suppliers: { data: null, error: null } }),
    )
    const res = await post(BODY)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('SUPPLIER_NOT_FOUND')
  })

  it('409 INBOX_ITEM_ALREADY_CONVERTED', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: MEMBER, invoice_inbox_items: { data: itemRow({ created_supplier_invoice_id: INVOICE_ID }), error: null } }),
    )
    const res = await post(BODY)
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('INBOX_ITEM_ALREADY_CONVERTED')
  })

  it('400 SI_CREATE_SLP_INVALID_ACCOUNT for särskild löneskatt outside 741x', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        invoice_inbox_items: { data: itemRow({ extracted_data: null }), error: null },
        suppliers: { data: { id: SUPPLIER_ID, name: 'Clas Ohlson AB', supplier_type: 'swedish_business' }, error: null },
      }),
    )
    const res = await post({ ...BODY, items: [{ ...BODY.items[0], apply_slp: true }] })
    expect((await res.json()).error.code).toBe('SI_CREATE_SLP_INVALID_ACCOUNT')
  })

  it('a dry run computes the invoice without an ankomstnummer, a supplier backfill or any write', async () => {
    const client = makeClient({
      company_members: MEMBER,
      invoice_inbox_items: { data: itemRow({ extracted_data: { supplier: { name: 'Clas Ohlson AB', bankgiro: '5050-1055' } } }), error: null },
      suppliers: { data: { id: SUPPLIER_ID, name: 'Clas Ohlson AB', supplier_type: 'swedish_business', bankgiro: null }, error: null },
      company_settings: { data: { accounting_method: 'accrual', defer_invoice_booking: false }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post(BODY, '?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview).toMatchObject({
      inbox_item_id: ITEM_ID,
      subtotal: 399.2,
      vat_amount: 99.8,
      total: 499,
      total_sek: 499,
      document_id: DOC_ID,
      would_create_registration_journal_entry: true,
    })
    expect(wrote(client)).toBe(false)
    expect(createSupplierInvoiceRegistrationEntry).not.toHaveBeenCalled()
  })

  it('201 registers the invoice, books the registration verifikat and marks the item converted', async () => {
    const client = makeClient({
      company_members: MEMBER,
      invoice_inbox_items: [{ data: itemRow({ extracted_data: null }), error: null }, { data: null, error: null }],
      suppliers: { data: { id: SUPPLIER_ID, name: 'Clas Ohlson AB', supplier_type: 'swedish_business' }, error: null },
      rpc: { data: 118, error: null },
      supplier_invoices: [
        {
          data: { id: INVOICE_ID, arrival_number: 118, status: 'registered', currency: 'SEK', total: 499, total_sek: 499, invoice_date: '2026-09-01' },
          error: null,
        },
        { data: null, error: null },
      ],
      supplier_invoice_items: { data: [{ id: '55555555-5555-4555-8555-555555555555', sort_order: 0 }], error: null },
      company_settings: { data: { accounting_method: 'accrual', defer_invoice_booking: false }, error: null },
      document_attachments: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post(BODY)
    expect(res.status).toBe(201)
    expect((await res.json()).data).toEqual({
      supplier_invoice_id: INVOICE_ID,
      arrival_number: 118,
      status: 'registered',
      currency: 'SEK',
      total: 499,
      total_sek: 499,
      registration_journal_entry_id: JE_ID,
      inbox_item_id: ITEM_ID,
    })
    const insert = client.calls.find((c) => c.table === 'supplier_invoices' && c.method === 'insert')
    expect(insert?.args[0]).toMatchObject({ company_id: COMPANY_ID, document_id: DOC_ID, total: 499, arrival_number: 118 })
    expect(client.calls).toContainEqual(
      expect.objectContaining({ table: 'invoice_inbox_items', method: 'update', args: [{ created_supplier_invoice_id: INVOICE_ID }] }),
    )
    expect(client.calls).toContainEqual(
      expect.objectContaining({ table: 'document_attachments', method: 'update', args: [{ journal_entry_id: JE_ID }] }),
    )
  })
})
