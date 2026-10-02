/**
 * The deferred "Bokför" step for customer invoices through the v1 door of
 * the operation registry (src/lib/operations/invoice-booking.ts):
 *   POST /api/v1/companies/:companyId/invoices/:id/book       (invoices.book)
 *   POST /api/v1/companies/:companyId/invoices/bulk-book      (invoices.bulk-book)
 *
 * The rules under test are the service's (lib/invoices/book-service.ts):
 * eligibility, kontantmetoden, the period-lock pre-check, the per-item
 * partial-success semantics of the bulk variant, and a dry run that previews
 * the real generator's lines and writes nothing.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeInvoice } from '@/tests/helpers'

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

// The committing half of the generator is replaced; the line-building half
// (buildInvoiceJournalEntryInput) stays real, so the dry run previews what
// the generator actually builds.
const createInvoiceJournalEntryMock = vi.fn()
vi.mock('@/lib/bookkeeping/invoice-entries', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/invoice-entries')>(
    '@/lib/bookkeeping/invoice-entries',
  )
  return { ...actual, createInvoiceJournalEntry: (...a: unknown[]) => createInvoiceJournalEntryMock(...a) }
})
vi.mock('@/lib/bookkeeping/accruals/from-invoices', () => ({
  createSchedulesForCustomerInvoice: vi.fn().mockResolvedValue({ created: 0, failed: 0 }),
}))
const cancelOrphanMock = vi.fn()
vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({
  cancelOrphanedPaymentEntry: (...a: unknown[]) => cancelOrphanMock(...a),
}))
vi.mock('@/lib/core/documents/document-service', () => ({ linkToJournalEntry: vi.fn() }))
const issueAndBookMock = vi.fn()
vi.mock('@/lib/invoices/issue-and-book-invoice', () => ({
  issueAndBookInvoice: (...a: unknown[]) => issueAndBookMock(...a),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as bookRoute } from '../route'
import { POST as bulkBookRoute } from '../../../bulk-book/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
}

/** Per-table queue mock that records every (table, method, args); the last entry repeats. */
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
  return { calls, from: vi.fn((table: string) => buildChain(table)), rpc }
}

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])
/** Business tables only: withApiV1's own bookkeeping (idempotency, usage) is not the operation's. */
const BOOKS = new Set(['invoices', 'journal_entries', 'journal_entry_lines', 'document_attachments'])
const wrote = (client: ReturnType<typeof makeClient>) =>
  client.calls.some((c) => (BOOKS.has(c.table) && WRITES.has(c.method)) || c.method === 'rpc')

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const INV_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const INV_2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const FP_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const JE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/invoices`

const ACCRUAL = { data: { accounting_method: 'accrual', entity_type: 'aktiebolag', defer_invoice_booking: true }, error: null }
const NO_LOCK_DATE = { data: { bookkeeping_locked_through: null }, error: null }
const OPEN_PERIOD = { data: { id: FP_ID, is_closed: false, locked_at: null }, error: null }
const OPEN_PERIOD_LIST = { data: [{ id: FP_ID }], error: null }

function sentInvoice(overrides: Record<string, unknown> = {}) {
  return {
    ...makeInvoice({ id: INV_ID, status: 'sent', invoice_date: '2026-09-10', invoice_number: 'F-1042' }),
    company_id: COMPANY_ID,
    journal_entry_id: null,
    customer: { name: 'Kunden AB' },
    items: [
      { id: 'item-1', line_type: 'item', description: 'Konsult', quantity: 10, unit_price: 1000, line_total: 10000, vat_rate: 25, vat_amount: 2500, sort_order: 0 },
    ],
    ...overrides,
  }
}

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
    scopes: ['invoices:read', 'invoices:write'],
    mode: 'live',
  })
})

describe('POST /api/v1/companies/:companyId/invoices/:id/book', () => {
  const book = (query = '', id = INV_ID) =>
    bookRoute(request(`${BASE}/${id}/book${query}`, { method: 'POST' }), {
      params: Promise.resolve({ companyId: COMPANY_ID, id }),
    })

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await book()).status).toBe(401)
  })

  it('403 without invoices:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['invoices:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await book()).status).toBe(403)
  })

  it('400 VALIDATION_ERROR for a path id that is not a UUID', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await book('', 'nope')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('404 INVOICE_NOT_FOUND for an invoice outside the company', async () => {
    const client = makeClient({ company_members: MEMBER, invoices: { data: null, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await book()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('INVOICE_NOT_FOUND')
    expect(client.calls).toContainEqual({ table: 'invoices', method: 'eq', args: ['company_id', COMPANY_ID] })
  })

  it.each([
    ['an already booked invoice', { journal_entry_id: JE_ID }, 'INVOICE_BOOK_ALREADY_BOOKED'],
    ['a credit note', { credited_invoice_id: INV_2 }, 'INVOICE_BOOK_NOT_BOOKABLE'],
    ['a quote', { document_type: 'quote' }, 'INVOICE_BOOK_NOT_BOOKABLE'],
    ['a draft', { status: 'draft' }, 'INVOICE_BOOK_INVALID_STATUS'],
    ['a paid invoice', { status: 'paid' }, 'INVOICE_BOOK_INVALID_STATUS'],
  ])('400 for %s, writing nothing', async (_label, overrides, code) => {
    const client = makeClient({ company_members: MEMBER, invoices: { data: sentInvoice(overrides), error: null }, company_settings: ACCRUAL })
    mockServiceClient.mockReturnValue(client)
    const res = await book()
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe(code)
    expect(wrote(client)).toBe(false)
    expect(createInvoiceJournalEntryMock).not.toHaveBeenCalled()
  })

  it('400 INVOICE_BOOK_CASH_METHOD under kontantmetoden', async () => {
    const client = makeClient({
      company_members: MEMBER,
      invoices: { data: sentInvoice(), error: null },
      company_settings: { data: { accounting_method: 'cash', entity_type: 'aktiebolag' }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await book()
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('INVOICE_BOOK_CASH_METHOD')
    expect(wrote(client)).toBe(false)
  })

  it('400 PERIOD_LOCKED when the covering period is locked, before anything is generated', async () => {
    const client = makeClient({
      company_members: MEMBER,
      invoices: { data: sentInvoice(), error: null },
      company_settings: [ACCRUAL, NO_LOCK_DATE],
      fiscal_periods: { data: { id: FP_ID, is_closed: false, locked_at: '2026-10-01T00:00:00Z' }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await book()
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('PERIOD_LOCKED')
    expect(body.error.details).toMatchObject({ reason: 'period_locked_at_set', fiscal_period_id: FP_ID, invoice_date: '2026-09-10' })
    expect(createInvoiceJournalEntryMock).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('400 PERIOD_LOCKED when the company lock date covers the invoice date', async () => {
    const client = makeClient({
      company_members: MEMBER,
      invoices: { data: sentInvoice(), error: null },
      company_settings: [ACCRUAL, { data: { bookkeeping_locked_through: '2026-09-30' }, error: null }],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await book()
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('PERIOD_LOCKED')
    expect(body.error.details.reason).toBe('company_lock_date_covers')
  })

  it('a dry run previews the generated revenue lines and writes nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      invoices: { data: sentInvoice(), error: null },
      company_settings: [ACCRUAL, NO_LOCK_DATE],
      fiscal_periods: [OPEN_PERIOD, OPEN_PERIOD_LIST],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await book('?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    const entry = body.data.preview.journal_entry
    expect(entry).toMatchObject({ fiscal_period_id: FP_ID, entry_date: '2026-09-10', balanced: true, total_debit: 12500, total_credit: 12500 })
    expect(entry.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_number: '1510', debit_amount: 12500, credit_amount: 0 }),
        expect.objectContaining({ account_number: '2611', debit_amount: 0, credit_amount: 2500 }),
      ]),
    )
    expect(createInvoiceJournalEntryMock).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('400 INVOICE_BOOK_NO_FISCAL_PERIOD when no open year covers the date (dry run too)', async () => {
    const client = makeClient({
      company_members: MEMBER,
      invoices: { data: sentInvoice(), error: null },
      company_settings: [ACCRUAL, NO_LOCK_DATE],
      fiscal_periods: [{ data: null, error: null }, { data: [], error: null }],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await book('?dry_run=true')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('INVOICE_BOOK_NO_FISCAL_PERIOD')
  })

  it('books the revenue verifikat, claims the invoice and answers the public shape', async () => {
    const client = makeClient({
      company_members: MEMBER,
      invoices: [
        { data: sentInvoice(), error: null },
        { data: sentInvoice({ journal_entry_id: JE_ID, user_id: 'user-1' }), error: null },
      ],
      company_settings: [ACCRUAL, NO_LOCK_DATE],
      fiscal_periods: OPEN_PERIOD,
    })
    mockServiceClient.mockReturnValue(client)
    createInvoiceJournalEntryMock.mockResolvedValue({ id: JE_ID })
    const res = await book()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.journal_entry_id).toBe(JE_ID)
    expect(body.data.invoice).toMatchObject({ id: INV_ID, invoice_number: 'F-1042', journal_entry_id: JE_ID })
    expect(body.data.invoice.user_id).toBeUndefined()
    expect(createInvoiceJournalEntryMock).toHaveBeenCalledWith(
      client,
      COMPANY_ID,
      'user-1',
      expect.objectContaining({ id: INV_ID }),
      'aktiebolag',
      'Kunden AB',
    )
    // The CAS-guarded claim: only an unbooked, bookable, uncredited row.
    expect(client.calls).toContainEqual({ table: 'invoices', method: 'is', args: ['journal_entry_id', null] })
  })

  it('409 INVOICE_BOOK_CONFLICT and a cancelled entry when another request booked first', async () => {
    const client = makeClient({
      company_members: MEMBER,
      invoices: [{ data: sentInvoice(), error: null }, { data: null, error: { message: 'no rows' } }],
      company_settings: [ACCRUAL, NO_LOCK_DATE],
      fiscal_periods: OPEN_PERIOD,
    })
    mockServiceClient.mockReturnValue(client)
    createInvoiceJournalEntryMock.mockResolvedValue({ id: JE_ID })
    const res = await book()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('INVOICE_BOOK_CONFLICT')
    expect(cancelOrphanMock).toHaveBeenCalledWith(client, COMPANY_ID, 'user-1', JE_ID, expect.any(String))
  })
})

describe('POST /api/v1/companies/:companyId/invoices/bulk-book', () => {
  const bulk = (body: unknown, query = '') =>
    bulkBookRoute(request(`${BASE}/bulk-book${query}`, { method: 'POST', body: JSON.stringify(body) }), {
      params: Promise.resolve({ companyId: COMPANY_ID }),
    })

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await bulk({ invoice_ids: [INV_ID] })).status).toBe(401)
  })

  it('403 without invoices:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['invoices:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await bulk({ invoice_ids: [INV_ID] })).status).toBe(403)
  })

  it('400 VALIDATION_ERROR for an empty list, a non-UUID, or more than 200 ids', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await bulk({ invoice_ids: [] })).status).toBe(400)
    expect((await bulk({ invoice_ids: ['nope'] })).status).toBe(400)
    const many = Array.from({ length: 201 }, () => crypto.randomUUID())
    expect((await bulk({ invoice_ids: many })).status).toBe(400)
  })

  it('400 INVOICE_BOOK_CASH_METHOD for the whole batch under kontantmetoden', async () => {
    const client = makeClient({
      company_members: MEMBER,
      company_settings: { data: { accounting_method: 'cash', entity_type: 'aktiebolag' }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await bulk({ invoice_ids: [INV_ID] })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('INVOICE_BOOK_CASH_METHOD')
    expect(wrote(client)).toBe(false)
  })

  it('partial success: 200 with one result per unique id, failures never stop the rest', async () => {
    const client = makeClient({
      company_members: MEMBER,
      company_settings: [ACCRUAL, NO_LOCK_DATE],
      invoices: [
        {
          data: [
            sentInvoice(),
            { ...sentInvoice({ id: INV_2, status: 'draft', invoice_number: null }) },
          ],
          error: null,
        },
        { data: sentInvoice({ journal_entry_id: JE_ID }), error: null },
      ],
      fiscal_periods: OPEN_PERIOD,
    })
    mockServiceClient.mockReturnValue(client)
    createInvoiceJournalEntryMock.mockResolvedValue({ id: JE_ID })
    const unknown = crypto.randomUUID()
    const res = await bulk({ invoice_ids: [INV_ID, INV_2, INV_ID, unknown] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.results).toEqual([
      { id: INV_ID, status: 'booked', journal_entry_id: JE_ID },
      // defer_invoice_booking: the draft is refused, never issued.
      expect.objectContaining({ id: INV_2, status: 'failed', error_code: 'INVOICE_BOOK_DEFERRED_DRAFT' }),
      expect.objectContaining({ id: unknown, status: 'failed', error_code: 'INVOICE_NOT_FOUND' }),
    ])
    expect(body.data.summary).toEqual({ total: 3, booked: 1, failed: 2 })
    expect(issueAndBookMock).not.toHaveBeenCalled()
    expect(createInvoiceJournalEntryMock).toHaveBeenCalledTimes(1)
  })

  it('a locked period fails its item with PERIOD_LOCKED and the rest still book', async () => {
    const client = makeClient({
      company_members: MEMBER,
      company_settings: [ACCRUAL, { data: { bookkeeping_locked_through: '2026-06-30' }, error: null }],
      invoices: [
        {
          data: [sentInvoice({ invoice_date: '2026-05-10' }), sentInvoice({ id: INV_2 })],
          error: null,
        },
        { data: sentInvoice({ id: INV_2, journal_entry_id: JE_ID }), error: null },
      ],
      fiscal_periods: OPEN_PERIOD,
    })
    mockServiceClient.mockReturnValue(client)
    createInvoiceJournalEntryMock.mockResolvedValue({ id: JE_ID })
    const res = await bulk({ invoice_ids: [INV_ID, INV_2] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.results[0]).toMatchObject({ id: INV_ID, status: 'failed', error_code: 'PERIOD_LOCKED' })
    expect(body.data.results[1]).toMatchObject({ id: INV_2, status: 'booked' })
  })

  it('a dry run answers per item what would happen, with the lines, and writes nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      company_settings: [ACCRUAL, NO_LOCK_DATE],
      invoices: { data: [sentInvoice(), sentInvoice({ id: INV_2, status: 'paid' })], error: null },
      fiscal_periods: [OPEN_PERIOD, OPEN_PERIOD_LIST],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await bulk({ invoice_ids: [INV_ID, INV_2] }, '?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    const { results, summary } = body.data.preview
    expect(results[0]).toMatchObject({ id: INV_ID, status: 'would_book', action: 'book', journal_entry: { balanced: true } })
    expect(results[1]).toMatchObject({ id: INV_2, status: 'failed', error_code: 'INVOICE_BOOK_INVALID_STATUS' })
    expect(summary).toEqual({ total: 2, would_book: 1, failed: 1 })
    expect(createInvoiceJournalEntryMock).not.toHaveBeenCalled()
    expect(issueAndBookMock).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })
})
