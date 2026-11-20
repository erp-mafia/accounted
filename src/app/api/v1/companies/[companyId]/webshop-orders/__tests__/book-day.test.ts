/**
 * POST /api/v1/companies/:companyId/webshop-orders/book-day
 * (webshop-orders.book-day, src/lib/operations/webshop-orders.ts) through the
 * v1 door. The engine's draft and commit are replaced, everything above them
 * runs: the day's rows are read, each order's lines derived and summed, and
 * every row claimed to the one verifikat. The booking rules themselves are
 * pinned in lib/webshop-orders/__tests__/book-day.test.ts.
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
const uploadDocumentMock = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: (...a: unknown[]) => uploadDocumentMock(...a),
}))
vi.mock('@/lib/webshop-orders/day-underlag', async () => {
  const actual = await vi.importActual<typeof import('@/lib/webshop-orders/day-underlag')>('@/lib/webshop-orders/day-underlag')
  return {
    ...actual,
    renderWebshopDayUnderlagPdf: vi.fn().mockResolvedValue({ bytes: new Uint8Array([37]), filename: 'Dagssammanstallning.pdf' }),
  }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as bookDayRoute } from '../book-day/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

function makeClient(byTable: Record<string, TableMockResult | TableMockResult[]>) {
  const { supabase, calls } = createTableMockSupabase(byTable)
  return Object.assign(supabase, { calls })
}

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])
const BOOKS = new Set(['webshop_orders', 'journal_entries', 'journal_entry_lines', 'chart_of_accounts', 'documents'])
const wrote = (client: ReturnType<typeof makeClient>) =>
  client.calls.some((c) => (BOOKS.has(c.table) && WRITES.has(c.method)) || (c.method === 'rpc' && !isIdempotencyClaim(c)))

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ORDER_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ORDER_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
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
const URL = `https://x.test/api/v1/companies/${COMPANY_ID}/webshop-orders/book-day`
const BODY = { platform: 'shopify', store_scope: 'butik.myshopify.com', date: '2026-10-14', payment_method: 'shopify_payments' }

function order(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    company_id: COMPANY_ID,
    platform: 'shopify',
    store_scope: 'butik.myshopify.com',
    store_label: 'Butiken',
    row_type: 'order',
    parent_order_id: null,
    order_number: id === ORDER_A ? '#1042' : '#1043',
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
    line_items: [],
    customer_country: 'SE',
    payment_method: 'shopify_payments',
    payment_method_title: 'shopify_payments',
    journal_entry_id: null,
    invoice_id: null,
    legacy_transaction_id: null,
    manually_booked_at: null,
    created_at: '2026-10-14T10:00:00Z',
    ...overrides,
  }
}

function request(body: unknown, query = ''): Request {
  return new Request(`${URL}${query}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
  })
}

const bookDay = (body: unknown = BODY, query = '') =>
  bookDayRoute(request(body, query), { params: Promise.resolve({ companyId: COMPANY_ID }) })

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
  commitEntryMock.mockResolvedValue(makeJournalEntry({ id: JE_ID, voucher_series: 'L', voucher_number: 41 }))
  uploadDocumentMock.mockResolvedValue({ id: 'doc-1' })
})

/** The day's two reads (by paid date, then by order date), the claim, then the claimed rows read back. */
function dayClient(rows: unknown[], claimed: unknown[] = rows.map((r) => ({ id: (r as { id: string }).id }))) {
  return makeClient({
    company_members: MEMBER,
    webshop_orders: [
      { data: rows, error: null },
      { data: [], error: null },
      { data: claimed, error: null },
      { data: rows, error: null },
    ],
    webshop_store_settings: { data: null, error: null },
    fiscal_periods: [OPEN_PERIOD_LIST, OPEN_PERIOD],
    company_settings: NO_LOCK_DATE,
    chart_of_accounts: ACTIVE_ACCOUNTS,
  })
}

describe('POST /api/v1/companies/:companyId/webshop-orders/book-day', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await bookDay()).status).toBe(401)
  })

  it('403 without bookkeeping:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await bookDay()).status).toBe(403)
  })

  it('400 VALIDATION_ERROR without a payment method', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await bookDay({ ...BODY, payment_method: undefined })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('400 WEBSHOP_DAY_EMPTY when the day has no unbooked orders with that payment method', async () => {
    const client = dayClient([])
    mockServiceClient.mockReturnValue(client)
    const res = await bookDay()
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('WEBSHOP_DAY_EMPTY')
    expect(wrote(client)).toBe(false)
  })

  it('a dry run previews one verifikat for the day and the rows to pin, and writes nothing', async () => {
    const client = dayClient([order(ORDER_A), order(ORDER_B)])
    mockServiceClient.mockReturnValue(client)
    const res = await bookDay(BODY, '?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({ order_ids: [ORDER_A, ORDER_B], date: '2026-10-14', skipped: [] })
    expect(body.data.preview.journal_entry).toMatchObject({
      fiscal_period_id: FP_ID,
      entry_date: '2026-10-14',
      description: 'Dagsförsäljning 2026-10-14 Butiken (shopify_payments)',
      balanced: true,
      total_debit: 2500,
      total_credit: 2500,
    })
    expect(createDraftEntryMock).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('books the day as one verifikat with the summed lines, claims every row and archives the summary', async () => {
    const client = dayClient([order(ORDER_A), order(ORDER_B)])
    mockServiceClient.mockReturnValue(client)
    const res = await bookDay()
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data).toMatchObject({
      journal_entry_id: JE_ID,
      voucher_series: 'L',
      voucher_number: 41,
      entry_date: '2026-10-14',
      booked: [
        { webshop_order_id: ORDER_A, order_number: '#1042', total_sek: 1250 },
        { webshop_order_id: ORDER_B, order_number: '#1043', total_sek: 1250 },
      ],
      skipped: [],
      underlag_document_id: 'doc-1',
    })
    expect(createDraftEntryMock).toHaveBeenCalledTimes(1)
    const draftInput = createDraftEntryMock.mock.calls[0][3] as { lines: Array<Record<string, unknown>> } & Record<string, unknown>
    expect(draftInput).toMatchObject({ entry_date: '2026-10-14', source_type: 'webshop_order' })
    expect(draftInput.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['1686', 2500, 0],
      ['2611', 0, 500],
      ['3001', 0, 2000],
    ])
    expect(client.calls).toContainEqual({ table: 'webshop_orders', method: 'update', args: [{ journal_entry_id: JE_ID }] })
    expect(client.calls).toContainEqual({ table: 'webshop_orders', method: 'in', args: ['id', [ORDER_A, ORDER_B]] })
    expect(client.calls).toContainEqual({ table: 'webshop_orders', method: 'is', args: ['manually_booked_at', null] })
    expect(uploadDocumentMock).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      COMPANY_ID,
      expect.objectContaining({ type: 'application/pdf' }),
      expect.objectContaining({ journal_entry_id: JE_ID, upload_source: 'system' }),
    )
  })

  it('409 WEBSHOP_DAY_CHANGED and a cancelled draft when another request claimed a row first', async () => {
    const client = dayClient([order(ORDER_A), order(ORDER_B)], [{ id: ORDER_A }])
    mockServiceClient.mockReturnValue(client)
    const res = await bookDay()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('WEBSHOP_DAY_CHANGED')
    expect(commitEntryMock).not.toHaveBeenCalled()
    expect(client.calls).toContainEqual({ table: 'webshop_orders', method: 'update', args: [{ journal_entry_id: null }] })
    expect(client.calls).toContainEqual({ table: 'journal_entries', method: 'update', args: [{ status: 'cancelled' }] })
  })
})
