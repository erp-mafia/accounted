/**
 * Webshop orders through the v1 door of the operation registry
 * (src/lib/operations/webshop-orders.ts):
 *   GET  /api/v1/companies/:companyId/webshop-orders                  (webshop-orders.list)
 *   GET  /api/v1/companies/:companyId/webshop-orders/:orderId         (webshop-orders.get)
 *   POST /api/v1/companies/:companyId/webshop-orders/:orderId/book    (webshop-orders.book)
 *
 * The booking is the Orders page's own write path (bookWebshopOrder): the
 * engine's draft and commit are replaced, everything above them runs, so
 * these tests pin the guards, the defaults an agent gets, a dry run that
 * refuses what the commit would and writes nothing, and the order link.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, isIdempotencyClaim, makeJournalEntry, type TableMockResult } from '@/tests/helpers'

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

// The engine's committing half is replaced; balance, line and period helpers stay real.
const createDraftEntryMock = vi.fn()
const commitEntryMock = vi.fn()
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>('@/lib/bookkeeping/engine')
  return {
    ...actual,
    createDraftEntry: (...a: unknown[]) => createDraftEntryMock(...a),
    commitEntry: (...a: unknown[]) => commitEntryMock(...a),
  }
})
vi.mock('@/lib/webshop-orders/ensure-accounts', () => ({
  ensureWebshopPrefillAccounts: vi.fn().mockResolvedValue(undefined),
}))
const archiveUnderlagMock = vi.fn()
vi.mock('@/lib/webshop-orders/order-underlag', () => ({
  archiveWebshopOrderUnderlag: (...a: unknown[]) => archiveUnderlagMock(...a),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as listRoute } from '../route'
import { GET as getRoute } from '../[orderId]/route'
import { POST as bookRoute } from '../[orderId]/book/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

/** The per-table mock from tests/helpers, with its recorded calls on the client for the assertions. */
function makeClient(byTable: Record<string, TableMockResult | TableMockResult[]>) {
  const { supabase, calls } = createTableMockSupabase(byTable)
  return Object.assign(supabase, { calls })
}

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])
const BOOKS = new Set(['webshop_orders', 'journal_entries', 'journal_entry_lines', 'chart_of_accounts', 'documents'])
const wrote = (client: ReturnType<typeof makeClient>) =>
  client.calls.some((c) => (BOOKS.has(c.table) && WRITES.has(c.method)) || (c.method === 'rpc' && !isIdempotencyClaim(c)))

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORDER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const FP_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const JE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }
const NO_LOCK_DATE = { data: { bookkeeping_locked_through: null }, error: null }
const OPEN_PERIOD = { data: { id: FP_ID, is_closed: false, locked_at: null }, error: null }
const OPEN_PERIOD_LIST = { data: [{ id: FP_ID }], error: null }
const ACTIVE_ACCOUNTS = {
  data: [{ account_number: '1686' }, { account_number: '3001' }, { account_number: '2611' }],
  error: null,
}
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/webshop-orders`

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    company_id: COMPANY_ID,
    user_id: 'user-1',
    platform: 'shopify',
    store_scope: 'butik.myshopify.com',
    store_label: 'Butiken',
    connection_id: null,
    row_type: 'order',
    parent_order_id: null,
    external_id: 'shopify_butik_order_1',
    platform_order_id: '1',
    order_number: '#1042',
    status: 'paid',
    is_paid: true,
    order_date: '2026-10-14',
    paid_date: '2026-10-14',
    currency: 'SEK',
    total: 1250,
    total_tax: 250,
    total_sek: 1250,
    exchange_rate: 1,
    vat_breakdown: [{ rate: 25, net: 1000, tax: 250 }],
    line_items: [{ name: 'Skidglasögon', quantity: 1, total: 1000, total_tax: 250, vat_rate: 25 }],
    customer_name: null,
    customer_company: null,
    customer_email: null,
    customer_orgnr: null,
    customer_country: 'DK',
    payment_method: 'shopify_payments',
    payment_method_title: 'shopify_payments',
    gateway_reference: null,
    refunded_total: 0,
    journal_entry_id: null,
    invoice_id: null,
    legacy_transaction_id: null,
    remote_changed_after_freeze: false,
    manually_booked_at: null,
    manually_booked_by: null,
    manually_booked_journal_entry_id: null,
    created_at: '2026-10-14T10:00:00Z',
    updated_at: '2026-10-14T10:00:00Z',
    ...overrides,
  }
}

const LINES = [
  { account_number: '1686', debit_amount: 1250, credit_amount: 0 },
  { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
  { account_number: '2611', debit_amount: 0, credit_amount: 250 },
]

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

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['transactions:read', 'bookkeeping:write'],
    mode: 'live',
  })
  createDraftEntryMock.mockResolvedValue(makeJournalEntry({ id: JE_ID, status: 'draft' }))
  commitEntryMock.mockResolvedValue(makeJournalEntry({ id: JE_ID, voucher_series: 'A', voucher_number: 214 }))
  archiveUnderlagMock.mockResolvedValue({ ok: true, documentId: 'doc-1' })
})

describe('GET /api/v1/companies/:companyId/webshop-orders', () => {
  const list = (query = '') =>
    listRoute(request(`${BASE}${query}`), { params: Promise.resolve({ companyId: COMPANY_ID }) })

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await list()).status).toBe(401)
  })

  it('403 without transactions:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['invoices:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await list()).status).toBe(403)
  })

  it('400 VALIDATION_ERROR for a country that is not two letters', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await list('?country=DEN')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('lists the company\'s rows with country and booking status, filtered and paginated', async () => {
    const client = makeClient({
      company_members: MEMBER,
      webshop_orders: { data: [order(), order({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', journal_entry_id: JE_ID })], error: null, count: 7 },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await list('?booked=unbooked&country=dk&limit=2&offset=4')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.total).toBe(7)
    expect(body.data.orders[0]).toMatchObject({
      webshop_order_id: ORDER_ID,
      customer_country: 'DK',
      booking_status: 'to_book',
      vat_breakdown: [{ rate: 25, net: 1000, tax: 250 }],
    })
    expect(body.data.orders[0].id).toBeUndefined()
    expect(body.data.orders[0].customer_email).toBeUndefined()
    expect(body.data.orders[1].booking_status).toBe('booked')
    expect(client.calls).toContainEqual({ table: 'webshop_orders', method: 'eq', args: ['company_id', COMPANY_ID] })
    expect(client.calls).toContainEqual({ table: 'webshop_orders', method: 'eq', args: ['customer_country', 'DK'] })
    expect(client.calls).toContainEqual({ table: 'webshop_orders', method: 'is', args: ['journal_entry_id', null] })
    expect(client.calls).toContainEqual({ table: 'webshop_orders', method: 'range', args: [4, 5] })
  })
})

describe('GET /api/v1/companies/:companyId/webshop-orders/:orderId', () => {
  const get = (id = ORDER_ID) =>
    getRoute(request(`${BASE}/${id}`), { params: Promise.resolve({ companyId: COMPANY_ID, orderId: id }) })

  it('400 VALIDATION_ERROR for an id that is not a UUID', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await get('nope')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('404 WEBSHOP_ORDER_NOT_FOUND for an order outside the company', async () => {
    const client = makeClient({ company_members: MEMBER, webshop_orders: { data: null, error: { message: 'no rows' } } })
    mockServiceClient.mockReturnValue(client)
    const res = await get()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('WEBSHOP_ORDER_NOT_FOUND')
    expect(client.calls).toContainEqual({ table: 'webshop_orders', method: 'eq', args: ['company_id', COMPANY_ID] })
  })

  it('answers the order with the dialog\'s suggestion and the country warning, writing nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      webshop_orders: { data: order(), error: null },
      webshop_store_settings: { data: null, error: null },
      fiscal_periods: OPEN_PERIOD_LIST,
    })
    mockServiceClient.mockReturnValue(client)
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.line_items).toHaveLength(1)
    expect(body.data.suggestion).toMatchObject({
      entry_date: '2026-10-14',
      fiscal_period_id: FP_ID,
      description: 'Order #1042 (shopify_payments)',
      payment_account: '1686',
      payment_account_mapped: false,
    })
    expect(body.data.suggestion.lines).toEqual([
      expect.objectContaining({ account_number: '1686', debit_amount: 1250, credit_amount: 0 }),
      expect.objectContaining({ account_number: '3001', debit_amount: 0, credit_amount: 1000 }),
      expect.objectContaining({ account_number: '2611', debit_amount: 0, credit_amount: 250 }),
    ])
    expect(body.data.warnings.map((w: { code: string }) => w.code)).toEqual(['country_outside_sweden'])
    expect(wrote(client)).toBe(false)
  })

  it('leaves the lines out while a foreign-currency order has no rate', async () => {
    const client = makeClient({
      company_members: MEMBER,
      webshop_orders: { data: order({ currency: 'EUR', total_sek: null, exchange_rate: null }), error: null },
      webshop_store_settings: { data: null, error: null },
      fiscal_periods: OPEN_PERIOD_LIST,
    })
    mockServiceClient.mockReturnValue(client)
    const body = await (await get()).json()
    expect(body.data.suggestion.lines).toBeNull()
  })
})

describe('POST /api/v1/companies/:companyId/webshop-orders/:orderId/book', () => {
  const book = (body: unknown = { lines: LINES }, query = '', id = ORDER_ID) =>
    bookRoute(request(`${BASE}/${id}/book${query}`, { method: 'POST', body: JSON.stringify(body) }), {
      params: Promise.resolve({ companyId: COMPANY_ID, orderId: id }),
    })

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await book()).status).toBe(401)
  })

  it('403 without bookkeeping:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await book()).status).toBe(403)
  })

  it('400 VALIDATION_ERROR without lines', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await book({})
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('404 WEBSHOP_ORDER_NOT_FOUND for an order outside the company', async () => {
    const client = makeClient({ company_members: MEMBER, webshop_orders: { data: null, error: { message: 'no rows' } } })
    mockServiceClient.mockReturnValue(client)
    const res = await book()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('WEBSHOP_ORDER_NOT_FOUND')
    expect(createDraftEntryMock).not.toHaveBeenCalled()
  })

  it.each([
    ['already booked', { journal_entry_id: JE_ID }, 'WEBSHOP_ORDER_ALREADY_BOOKED'],
    ['invoiced', { invoice_id: JE_ID }, 'WEBSHOP_ORDER_ALREADY_INVOICED'],
    ['marked as booked outside', { manually_booked_at: '2026-10-15T10:00:00Z' }, 'WEBSHOP_ORDER_MANUALLY_BOOKED'],
    ['unpaid', { is_paid: false }, 'WEBSHOP_ORDER_NOT_PAID'],
  ])('409 for an order %s, writing nothing', async (_label, overrides, code) => {
    const client = makeClient({ company_members: MEMBER, webshop_orders: { data: order(overrides), error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await book()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe(code)
    expect(wrote(client)).toBe(false)
    expect(createDraftEntryMock).not.toHaveBeenCalled()
  })

  it('400 JOURNAL_ENTRY_NOT_BALANCED for lines that do not balance', async () => {
    const client = makeClient({ company_members: MEMBER, webshop_orders: { data: order(), error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await book({ lines: [LINES[0], LINES[1]] })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('JOURNAL_ENTRY_NOT_BALANCED')
    expect(createDraftEntryMock).not.toHaveBeenCalled()
  })

  it('refuses a date no open fiscal period covers', async () => {
    const client = makeClient({
      company_members: MEMBER,
      webshop_orders: { data: order(), error: null },
      fiscal_periods: { data: [], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await book({ lines: LINES }, '?dry_run=true')
    expect((await res.json()).error.code).toBe('FISCAL_PERIOD_NOT_FOUND')
    expect(wrote(client)).toBe(false)
  })

  it('400 PERIOD_LOCKED when the company lock date covers the entry date', async () => {
    const client = makeClient({
      company_members: MEMBER,
      webshop_orders: { data: order(), error: null },
      fiscal_periods: [OPEN_PERIOD_LIST, OPEN_PERIOD],
      company_settings: { data: { bookkeeping_locked_through: '2026-10-31' }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await book()
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('PERIOD_LOCKED')
    expect(body.error.details).toMatchObject({ reason: 'company_lock_date_covers', entry_date: '2026-10-14' })
    expect(createDraftEntryMock).not.toHaveBeenCalled()
  })

  it('a dry run previews the verifikat with the defaults filled in and writes nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      webshop_orders: { data: order(), error: null },
      fiscal_periods: [OPEN_PERIOD_LIST, OPEN_PERIOD],
      company_settings: NO_LOCK_DATE,
      chart_of_accounts: ACTIVE_ACCOUNTS,
      webshop_store_settings: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await book({ lines: LINES }, '?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({
      webshop_order_id: ORDER_ID,
      order_number: '#1042',
      customer_country: 'DK',
      warnings: ['country_outside_sweden'],
    })
    expect(body.data.preview.journal_entry).toMatchObject({
      fiscal_period_id: FP_ID,
      entry_date: '2026-10-14',
      description: 'Order #1042 (shopify_payments)',
      balanced: true,
      total_debit: 1250,
      total_credit: 1250,
    })
    expect(createDraftEntryMock).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('books through the Orders page\'s path: source_type webshop_order, the order claimed, the underlag archived', async () => {
    const client = makeClient({
      company_members: MEMBER,
      webshop_orders: [{ data: order(), error: null }, { data: order(), error: null }, { data: [{ id: ORDER_ID }], error: null }],
      fiscal_periods: [OPEN_PERIOD_LIST, OPEN_PERIOD],
      company_settings: NO_LOCK_DATE,
      chart_of_accounts: ACTIVE_ACCOUNTS,
    })
    mockServiceClient.mockReturnValue(client)
    const res = await book({ lines: LINES, description: 'Order #1042 DK' })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data).toEqual({
      webshop_order_id: ORDER_ID,
      journal_entry_id: JE_ID,
      voucher_series: 'A',
      voucher_number: 214,
      entry_date: '2026-10-14',
      underlag_archived: true,
    })
    const draftInput = createDraftEntryMock.mock.calls[0][3] as Record<string, unknown>
    expect(draftInput).toMatchObject({
      fiscal_period_id: FP_ID,
      entry_date: '2026-10-14',
      description: 'Order #1042 DK',
      source_type: 'webshop_order',
      source_id: ORDER_ID,
      lines: LINES,
    })
    // The race-free claim of the Orders page: only an unbooked, uninvoiced, unmarked row.
    expect(client.calls).toContainEqual({ table: 'webshop_orders', method: 'update', args: [{ journal_entry_id: JE_ID }] })
    expect(client.calls).toContainEqual({ table: 'webshop_orders', method: 'is', args: ['manually_booked_at', null] })
    expect(archiveUnderlagMock).toHaveBeenCalledWith(expect.objectContaining({ journalEntryId: JE_ID }))
  })

  it('409 WEBSHOP_ORDER_ALREADY_BOOKED and a cancelled draft when another request claimed the order first', async () => {
    const client = makeClient({
      company_members: MEMBER,
      webshop_orders: [{ data: order(), error: null }, { data: order(), error: null }, { data: [], error: null }],
      fiscal_periods: [OPEN_PERIOD_LIST, OPEN_PERIOD],
      company_settings: NO_LOCK_DATE,
      chart_of_accounts: ACTIVE_ACCOUNTS,
    })
    mockServiceClient.mockReturnValue(client)
    const res = await book()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('WEBSHOP_ORDER_ALREADY_BOOKED')
    expect(commitEntryMock).not.toHaveBeenCalled()
    expect(client.calls).toContainEqual({ table: 'journal_entries', method: 'update', args: [{ status: 'cancelled' }] })
  })
})
