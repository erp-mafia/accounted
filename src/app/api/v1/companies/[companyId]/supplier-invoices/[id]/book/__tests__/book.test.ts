/**
 * The deferred "Bokför" step for supplier invoices through the v1 door of
 * the operation registry (src/lib/operations/invoice-booking.ts):
 *   POST /api/v1/companies/:companyId/supplier-invoices/:id/book (supplier-invoices.book)
 *
 * The rules under test are the service's (lib/supplier-invoices/book-service.ts):
 * eligibility, kontantmetoden, the period-lock pre-check, the CAS claim, and
 * a dry run that previews the real generator's lines and writes nothing.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeSupplierInvoice } from '@/tests/helpers'

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

// The committing half of the generator is replaced; the line-building half
// stays real, so the dry run previews what the generator actually builds.
const createRegistrationEntryMock = vi.fn()
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/supplier-invoice-entries')>(
    '@/lib/bookkeeping/supplier-invoice-entries',
  )
  return { ...actual, createSupplierInvoiceRegistrationEntry: (...a: unknown[]) => createRegistrationEntryMock(...a) }
})
const createSchedulesMock = vi.fn()
vi.mock('@/lib/bookkeeping/accruals/from-invoices', () => ({
  createSchedulesForSupplierInvoice: (...a: unknown[]) => createSchedulesMock(...a),
}))
const cancelOrphanMock = vi.fn()
vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({
  cancelOrphanedPaymentEntry: (...a: unknown[]) => cancelOrphanMock(...a),
}))
const anchorMock = vi.fn()
vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({
  anchorSupplierInvoiceDocument: (...a: unknown[]) => anchorMock(...a),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as bookRoute } from '../route'

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
const BOOKS = new Set(['supplier_invoices', 'journal_entries', 'journal_entry_lines', 'document_attachments'])
const wrote = (client: ReturnType<typeof makeClient>) =>
  client.calls.some((c) => (BOOKS.has(c.table) && WRITES.has(c.method)) || c.method === 'rpc')

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SI_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const FP_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const JE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }
const URL_BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices`

const ACCRUAL = { data: { accounting_method: 'accrual' }, error: null }
const NO_LOCK_DATE = { data: { bookkeeping_locked_through: null }, error: null }
const OPEN_PERIOD = { data: { id: FP_ID, is_closed: false, locked_at: null }, error: null }
const OPEN_PERIOD_LIST = { data: [{ id: FP_ID }], error: null }

function registered(overrides: Record<string, unknown> = {}) {
  return {
    ...makeSupplierInvoice({ id: SI_ID, invoice_date: '2026-09-03', arrival_number: 118, supplier_invoice_number: '55012' }),
    company_id: COMPANY_ID,
    items: [{ id: 'item-1', description: 'Kontorsmaterial', account_number: '6110', line_total: 8000, vat_rate: 0.25, vat_amount: 2000 }],
    supplier: { id: 'sup-1', name: 'Leverantören AB', supplier_type: 'swedish_business' },
    ...overrides,
  }
}

function request(url: string): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
    },
  })
}

const book = (query = '', id = SI_ID) =>
  bookRoute(request(`${URL_BASE}/${id}/book${query}`), { params: Promise.resolve({ companyId: COMPANY_ID, id }) })

beforeEach(() => {
  vi.clearAllMocks()
  createSchedulesMock.mockResolvedValue({ created: 1, failed: 0 })
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['suppliers:read', 'suppliers:write'],
    mode: 'live',
  })
})

describe('POST /api/v1/companies/:companyId/supplier-invoices/:id/book', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await book()).status).toBe(401)
  })

  it('403 without suppliers:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['suppliers:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    expect((await book()).status).toBe(403)
  })

  it('400 VALIDATION_ERROR for a path id that is not a UUID', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await book('', 'nope')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('404 SI_NOT_FOUND for an invoice outside the company', async () => {
    const client = makeClient({ company_members: MEMBER, supplier_invoices: { data: null, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await book()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('SI_NOT_FOUND')
    expect(client.calls).toContainEqual({ table: 'supplier_invoices', method: 'eq', args: ['company_id', COMPANY_ID] })
  })

  it.each([
    ['an already booked invoice', { registration_journal_entry_id: JE_ID }, 'SI_BOOK_ALREADY_BOOKED'],
    ['a credit note', { is_credit_note: true }, 'SI_BOOK_NOT_BOOKABLE'],
    ['a paid invoice', { status: 'paid' }, 'SI_BOOK_INVALID_STATUS'],
    ['a partially paid invoice', { status: 'partially_paid' }, 'SI_BOOK_INVALID_STATUS'],
  ])('400 for %s, writing nothing', async (_label, overrides, code) => {
    const client = makeClient({ company_members: MEMBER, supplier_invoices: { data: registered(overrides), error: null }, company_settings: ACCRUAL })
    mockServiceClient.mockReturnValue(client)
    const res = await book()
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe(code)
    expect(wrote(client)).toBe(false)
  })

  it('400 SI_BOOK_CASH_METHOD under kontantmetoden', async () => {
    const client = makeClient({
      company_members: MEMBER,
      supplier_invoices: { data: registered(), error: null },
      company_settings: { data: { accounting_method: 'cash' }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await book()
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('SI_BOOK_CASH_METHOD')
  })

  it('400 PERIOD_LOCKED in a closed year, before anything is generated', async () => {
    const client = makeClient({
      company_members: MEMBER,
      supplier_invoices: { data: registered(), error: null },
      company_settings: [ACCRUAL, NO_LOCK_DATE],
      fiscal_periods: { data: { id: FP_ID, is_closed: true, locked_at: '2026-12-31T00:00:00Z' }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await book()
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('PERIOD_LOCKED')
    expect(body.error.details).toMatchObject({ reason: 'period_is_closed', fiscal_period_id: FP_ID, invoice_date: '2026-09-03' })
    expect(createRegistrationEntryMock).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('a dry run previews the registration lines and writes nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      supplier_invoices: { data: registered(), error: null },
      company_settings: [ACCRUAL, NO_LOCK_DATE],
      fiscal_periods: [OPEN_PERIOD, OPEN_PERIOD_LIST],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await book('?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    const { journal_entry: entry } = body.data.preview
    expect(entry).toMatchObject({ fiscal_period_id: FP_ID, entry_date: '2026-09-03', balanced: true, total_debit: 10000 })
    expect(entry.lines).toEqual([
      expect.objectContaining({ account_number: '6110', debit_amount: 8000, credit_amount: 0 }),
      expect.objectContaining({ account_number: '2641', debit_amount: 2000, credit_amount: 0 }),
      expect.objectContaining({ account_number: '2440', debit_amount: 0, credit_amount: 10000 }),
    ])
    expect(createRegistrationEntryMock).not.toHaveBeenCalled()
    expect(anchorMock).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('books the registration verifikat, claims the invoice, anchors the underlag and creates schedules', async () => {
    const withAccrual = registered({
      items: [
        {
          id: 'item-1',
          account_number: '5010',
          line_total: 8000,
          vat_rate: 0.25,
          vat_amount: 2000,
          accrual_period_start: '2026-10-01',
          accrual_period_end: '2026-12-31',
        },
      ],
    })
    const client = makeClient({
      company_members: MEMBER,
      supplier_invoices: [
        { data: withAccrual, error: null },
        { data: { ...withAccrual, registration_journal_entry_id: JE_ID }, error: null },
      ],
      company_settings: [ACCRUAL, NO_LOCK_DATE],
      fiscal_periods: OPEN_PERIOD,
    })
    mockServiceClient.mockReturnValue(client)
    createRegistrationEntryMock.mockResolvedValue({ id: JE_ID })
    const res = await book()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({
      journal_entry_id: JE_ID,
      supplier_invoice: { id: SI_ID, arrival_number: 118, registration_journal_entry_id: JE_ID },
    })
    expect(body.data.supplier_invoice.user_id).toBeUndefined()
    expect(createRegistrationEntryMock).toHaveBeenCalledWith(
      client,
      COMPANY_ID,
      'user-1',
      expect.objectContaining({ id: SI_ID }),
      expect.any(Array),
      'swedish_business',
      'Leverantören AB',
    )
    expect(client.calls).toContainEqual({ table: 'supplier_invoices', method: 'is', args: ['registration_journal_entry_id', null] })
    expect(anchorMock).toHaveBeenCalledWith(client, COMPANY_ID, SI_ID)
    expect(createSchedulesMock).toHaveBeenCalled()
  })

  it('a schedule failure is a warning, not a failure: the verifikat stands', async () => {
    const withAccrual = registered({
      items: [{ id: 'item-1', account_number: '5010', line_total: 8000, accrual_period_start: '2026-10-01', accrual_period_end: '2026-12-31' }],
    })
    const client = makeClient({
      company_members: MEMBER,
      supplier_invoices: [
        { data: withAccrual, error: null },
        { data: { ...withAccrual, registration_journal_entry_id: JE_ID }, error: null },
      ],
      company_settings: [ACCRUAL, NO_LOCK_DATE],
      fiscal_periods: OPEN_PERIOD,
    })
    mockServiceClient.mockReturnValue(client)
    createRegistrationEntryMock.mockResolvedValue({ id: JE_ID })
    createSchedulesMock.mockResolvedValue({ created: 0, failed: 1 })
    const res = await book()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.warnings).toEqual([expect.objectContaining({ code: 'ACCRUAL_SCHEDULE_FAILED' })])
  })

  it('409 SI_BOOK_CONFLICT and a cancelled entry when another request booked first', async () => {
    const client = makeClient({
      company_members: MEMBER,
      supplier_invoices: [{ data: registered(), error: null }, { data: null, error: { message: 'no rows' } }],
      company_settings: [ACCRUAL, NO_LOCK_DATE],
      fiscal_periods: OPEN_PERIOD,
    })
    mockServiceClient.mockReturnValue(client)
    createRegistrationEntryMock.mockResolvedValue({ id: JE_ID })
    const res = await book()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('SI_BOOK_CONFLICT')
    expect(cancelOrphanMock).toHaveBeenCalledWith(client, COMPANY_ID, 'user-1', JE_ID, expect.any(String))
    expect(anchorMock).not.toHaveBeenCalled()
  })
})
