/**
 * Bank transaction actions through the v1 door of the operation registry
 * (src/lib/operations/transactions.ts via lib/operations/v1.ts):
 *   DELETE /transactions/:id                       transactions.delete
 *   PATCH  /transactions/:id                       transactions.update
 *   POST   /transactions/:id/refresh-exchange-rate transactions.refresh-exchange-rate
 *   POST   /transactions/:id/link-journal-entry    transactions.link-journal-entry
 *   POST   /transactions/:id/match-batch           transactions.match-batch
 *   POST   /transactions/bulk-book                 transactions.bulk-book
 *
 * The rules under test are the services' (lib/transactions/manage.ts,
 * link-journal-entry.ts, match-batch.ts, bulk-book.ts): only unbooked rows
 * change, bank rows are never deleted, and a dry run writes nothing.
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
vi.mock('@/lib/events/bus', () => ({ eventBus: { emit: vi.fn().mockResolvedValue(undefined) } }))
const fetchRateMock = vi.fn()
vi.mock('@/lib/currency/riksbanken', () => ({ fetchExchangeRate: (...a: unknown[]) => fetchRateMock(...a) }))
const detectExplainingMock = vi.fn()
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectExplainingVoucherSetForTransaction: (...a: unknown[]) => detectExplainingMock(...a),
}))
const cashCheckMock = vi.fn()
vi.mock('@/lib/invoices/batch-cash-method-guard', () => ({
  findCashMethodUnbookedAllocations: (...a: unknown[]) => cashCheckMock(...a),
}))
vi.mock('@/lib/invoices/clear-settled-batch-allocations', () => ({
  clearSettledBatchAllocationSuggestions: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/invoices/match-log', () => ({ logMatchEvent: vi.fn() }))
vi.mock('@/lib/transactions/inbox-underlag', () => ({
  propagateUnderlagForBookedTransaction: vi.fn().mockResolvedValue(undefined),
}))
const detectDuplicateMock = vi.fn()
vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: (...a: unknown[]) => detectDuplicateMock(...a),
}))
vi.mock('@/lib/processing-history/append', () => ({ appendProcessingHistory: vi.fn() }))
vi.mock('@/lib/bookkeeping/dimension-rules', () => ({
  fetchActiveDimensionRules: vi.fn().mockResolvedValue([]),
  applyDimensionRules: vi.fn((lines: unknown) => lines),
  assertMandatoryDimensions: vi.fn(),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { DELETE as deleteTx, PATCH as patchTx } from '../[id]/route'
import { POST as refreshRate } from '../[id]/refresh-exchange-rate/route'
import { POST as linkJe } from '../[id]/link-journal-entry/route'
import { POST as matchBatch } from '../[id]/match-batch/route'
import { POST as bulkBook } from '../bulk-book/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
  count?: number
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
    return buildChain(`rpc:${String(args[0])}`)
  })
  return { calls, from: vi.fn((table: string) => buildChain(table)), rpc }
}

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])
const BOOKS = new Set(['transactions', 'invoices', 'invoice_payments', 'cash_accounts', 'journal_entries'])
const wrote = (client: ReturnType<typeof makeClient>) =>
  client.calls.some((c) => (BOOKS.has(c.table) && WRITES.has(c.method)) || c.method === 'rpc')

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TX_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TX2_ID = 'b2b2b2b2-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const JE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const INV_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const INV2_ID = 'd2d2d2d2-dddd-4ddd-8ddd-dddddddddddd'
const CA_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/transactions`

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

const txParams = (id = TX_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })
const companyParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }

function manualTx(overrides: Record<string, unknown> = {}) {
  return {
    id: TX_ID,
    journal_entry_id: null,
    invoice_id: null,
    supplier_invoice_id: null,
    bank_connection_id: null,
    import_source: 'manual',
    description: 'ICA',
    original_description: 'ICA',
    currency: 'SEK',
    cash_account_id: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  detectExplainingMock.mockResolvedValue(null)
  cashCheckMock.mockResolvedValue({ ok: true, unbooked: [] })
  detectDuplicateMock.mockResolvedValue(null)
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['transactions:read', 'transactions:write'],
    mode: 'live',
  })
})

// ---------------------------------------------------------------------------

describe('DELETE /transactions/:id (transactions.delete)', () => {
  const del = (query = '', id = TX_ID) => deleteTx(request(`${BASE}/${id}${query}`, { method: 'DELETE' }), txParams(id))

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await del()).status).toBe(401)
  })

  it('403 without transactions:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await del()).status).toBe(403)
  })

  it('400 VALIDATION_ERROR on a non-uuid id', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    const res = await del('', 'not-a-uuid')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('404 when the row is not in the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, transactions: { data: null, error: { code: 'PGRST116' } } }))
    const res = await del()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('TX_CATEGORIZE_TX_NOT_FOUND')
  })

  it('409 TRANSACTION_DELETE_BOOKED for a booked row, nothing written', async () => {
    const client = makeClient({ company_members: OWNER, transactions: { data: manualTx({ journal_entry_id: JE_ID }), error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await del()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('TRANSACTION_DELETE_BOOKED')
    expect(wrote(client)).toBe(false)
  })

  it('409 TRANSACTION_DELETE_IMPORTED for a bank-synced or file-imported row', async () => {
    for (const origin of [{ bank_connection_id: CA_ID, import_source: 'enable_banking' }, { import_source: 'csv' }]) {
      const client = makeClient({ company_members: OWNER, transactions: { data: manualTx(origin), error: null } })
      mockServiceClient.mockReturnValue(client)
      const res = await del()
      expect(res.status).toBe(409)
      expect((await res.json()).error.code).toBe('TRANSACTION_DELETE_IMPORTED')
      expect(wrote(client)).toBe(false)
    }
  })

  it('409 TRANSACTION_DELETE_HAS_AUDIT_TRAIL when the immutability trigger refuses', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: OWNER,
        transactions: [
          { data: manualTx(), error: null },
          { data: null, error: { code: 'P0001', message: 'Audit log entries cannot be modified or deleted' } },
        ],
      }),
    )
    const res = await del()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('TRANSACTION_DELETE_HAS_AUDIT_TRAIL')
  })

  it('dry run answers the preview and writes nothing', async () => {
    const client = makeClient({ company_members: OWNER, transactions: { data: manualTx(), error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await del('?dry_run=true')
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toMatchObject({ transaction_id: TX_ID, would_delete: true })
    expect(wrote(client)).toBe(false)
  })

  it('200 deletes a manual unbooked row, scoped to the company', async () => {
    const client = makeClient({
      company_members: OWNER,
      transactions: [
        { data: manualTx(), error: null },
        { data: null, error: null },
      ],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await del()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ transaction_id: TX_ID, deleted: true })
    expect(client.calls.some((c) => c.table === 'transactions' && c.method === 'delete')).toBe(true)
    expect(client.calls).toContainEqual({ table: 'transactions', method: 'eq', args: ['company_id', COMPANY_ID] })
  })
})

// ---------------------------------------------------------------------------

describe('PATCH /transactions/:id (transactions.update)', () => {
  const patch = (body: unknown, query = '') =>
    patchTx(request(`${BASE}/${TX_ID}${query}`, { method: 'PATCH', body: JSON.stringify(body) }), txParams())

  it('401 / 403 / 400', async () => {
    mockValidate.mockResolvedValueOnce({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await patch({ description: 'x' })).status).toBe(401)

    mockValidate.mockResolvedValueOnce({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:read'], mode: 'live' })
    expect((await patch({ description: 'x' })).status).toBe(403)

    const empty = await patch({})
    expect(empty.status).toBe(400)
    expect((await empty.json()).error.code).toBe('VALIDATION_ERROR')
    // account numbers are strings in 19xx
    expect((await patch({ account_number: 1931 })).status).toBe(400)
    expect((await patch({ account_number: '3001' })).status).toBe(400)
  })

  it('404 when the row is not in the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, transactions: { data: null, error: { code: 'PGRST116' } } }))
    expect((await patch({ description: 'Lunch' })).status).toBe(404)
  })

  it('409 TRANSACTION_TITLE_LOCKED / TRANSACTION_MOVE_BOOKED for a matched row', async () => {
    const client = makeClient({ company_members: OWNER, transactions: { data: manualTx({ supplier_invoice_id: INV_ID }), error: null } })
    mockServiceClient.mockReturnValue(client)
    const title = await patch({ description: 'Lunch' })
    expect(title.status).toBe(409)
    expect((await title.json()).error.code).toBe('TRANSACTION_TITLE_LOCKED')
    const move = await patch({ account_number: '1931' })
    expect((await move.json()).error.code).toBe('TRANSACTION_MOVE_BOOKED')
    expect(wrote(client)).toBe(false)
  })

  it('409 TRANSACTION_MOVE_BOOKED for a row bulk-booked through voucher links', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: OWNER,
        transactions: { data: manualTx(), error: null },
        transaction_voucher_links: { data: [{ transaction_id: TX_ID }], error: null },
      }),
    )
    expect((await (await patch({ account_number: '1931' })).json()).error.code).toBe('TRANSACTION_MOVE_BOOKED')
  })

  it('400 TRANSACTION_MOVE_CURRENCY_MISMATCH for a target in another currency', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: OWNER,
        transactions: { data: manualTx({ currency: 'EUR' }), error: null },
        transaction_voucher_links: { data: [], error: null },
        cash_accounts: { data: { id: CA_ID, ledger_account: '1931', currency: 'SEK', enabled: true, bank_connection_id: null }, error: null },
      }),
    )
    const res = await patch({ account_number: '1931' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('TRANSACTION_MOVE_CURRENCY_MISMATCH')
  })

  it('dry run previews title and move, writes nothing', async () => {
    const client = makeClient({
      company_members: OWNER,
      transactions: { data: manualTx(), error: null },
      transaction_voucher_links: { data: [], error: null },
      cash_accounts: { data: { id: CA_ID, ledger_account: '1931', currency: 'SEK', enabled: false, bank_connection_id: null }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await patch({ description: 'Lunch', account_number: '1931' }, '?dry_run=true')
    expect(res.status).toBe(200)
    const preview = (await res.json()).data.preview
    expect(preview.description).toMatchObject({ from: 'ICA', to: 'Lunch', restores_bank_original: false })
    expect(preview.cash_account).toMatchObject({ to_cash_account_id: CA_ID, reenables_account: true })
    expect(wrote(client)).toBe(false)
  })

  it('200 updates title and account in one guarded UPDATE', async () => {
    const client = makeClient({
      company_members: OWNER,
      transactions: [
        { data: manualTx(), error: null },
        { data: { id: TX_ID, description: 'Lunch', title_edited_at: '2026-06-01T10:00:00Z', cash_account_id: CA_ID }, error: null },
      ],
      transaction_voucher_links: { data: [], error: null },
      cash_accounts: { data: { id: CA_ID, ledger_account: '1931', currency: 'SEK', enabled: true, bank_connection_id: null }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await patch({ description: 'Lunch', account_number: '1931' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ id: TX_ID, description: 'Lunch', title_edited_at: '2026-06-01T10:00:00Z', cash_account_id: CA_ID })
    const update = client.calls.find((c) => c.table === 'transactions' && c.method === 'update')
    expect(update?.args[0]).toMatchObject({ description: 'Lunch', cash_account_id: CA_ID })
    expect(client.calls).toContainEqual({ table: 'transactions', method: 'is', args: ['supplier_invoice_id', null] })
  })
})

// ---------------------------------------------------------------------------

describe('POST /transactions/:id/refresh-exchange-rate', () => {
  const post = (query = '') => refreshRate(request(`${BASE}/${TX_ID}/refresh-exchange-rate${query}`, { method: 'POST' }), txParams())
  const eurTx = (o: Record<string, unknown> = {}) => ({ id: TX_ID, currency: 'EUR', amount: -100, date: '2026-05-12', amount_sek: null, exchange_rate: null, journal_entry_id: null, ...o })

  it('401 / 403 / 404', async () => {
    mockValidate.mockResolvedValueOnce({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, transactions: { data: null, error: { code: 'PGRST116' } } }))
    expect((await post()).status).toBe(401)
    mockValidate.mockResolvedValueOnce({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:read'], mode: 'live' })
    expect((await post()).status).toBe(403)
    expect((await post()).status).toBe(404)
  })

  it('400 on a non-uuid id', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    const res = await refreshRate(request(`${BASE}/nope/refresh-exchange-rate`, { method: 'POST' }), txParams('nope'))
    expect(res.status).toBe(400)
  })

  it('409 TX_EXCHANGE_RATE_BOOKED for a booked row', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, transactions: { data: eurTx({ journal_entry_id: JE_ID }), error: null } }))
    expect((await (await post()).json()).error.code).toBe('TX_EXCHANGE_RATE_BOOKED')
    expect(fetchRateMock).not.toHaveBeenCalled()
  })

  it('dry run neither calls Riksbanken nor writes', async () => {
    const client = makeClient({ company_members: OWNER, transactions: { data: eurTx(), error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await post('?dry_run=true')
    expect((await res.json()).data.preview).toMatchObject({ needs_rate: true, currency: 'EUR' })
    expect(fetchRateMock).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('200 stores the rate and SEK amount rounded to the öre', async () => {
    fetchRateMock.mockResolvedValue({ rate: 11.50456, date: '2026-05-12' })
    const client = makeClient({
      company_members: OWNER,
      transactions: [
        { data: eurTx(), error: null },
        { data: eurTx({ amount_sek: -1150.46, exchange_rate: 11.50456, exchange_rate_date: '2026-05-12' }), error: null },
      ],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ refreshed: true, amount_sek: -1150.46, exchange_rate: 11.50456 })
    const update = client.calls.find((c) => c.table === 'transactions' && c.method === 'update')
    expect(update?.args[0]).toEqual({ amount_sek: -1150.46, exchange_rate: 11.50456, exchange_rate_date: '2026-05-12' })
  })

  it('SEK rows are answered unchanged with refreshed=false', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, transactions: { data: eurTx({ currency: 'SEK' }), error: null } }))
    expect((await (await post()).json()).data.refreshed).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe('POST /transactions/:id/link-journal-entry', () => {
  const post = (body: unknown, query = '') =>
    linkJe(request(`${BASE}/${TX_ID}/link-journal-entry${query}`, { method: 'POST', body: JSON.stringify(body) }), txParams())
  const txRow = { id: TX_ID, date: '2026-05-12', amount: 500, currency: 'SEK', exchange_rate: null, journal_entry_id: null, invoice_id: null, is_business: null, potential_invoice_id: null, potential_supplier_invoice_id: null, transaction_voucher_links: [] }

  it('401 / 403 / 400', async () => {
    mockValidate.mockResolvedValueOnce({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await post({ journal_entry_id: JE_ID })).status).toBe(401)
    mockValidate.mockResolvedValueOnce({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:read'], mode: 'live' })
    expect((await post({ journal_entry_id: JE_ID })).status).toBe(403)
    expect((await post({})).status).toBe(400)
  })

  it('404 when the transaction is not in the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, transactions: { data: null, error: { code: 'PGRST116' } } }))
    expect((await (await post({ journal_entry_id: JE_ID })).json()).error.code).toBe('TX_CATEGORIZE_TX_NOT_FOUND')
  })

  it('refuses a draft verifikat (LINK_TX_JE_NOT_POSTED)', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: OWNER, transactions: { data: txRow, error: null }, journal_entries: { data: { id: JE_ID, status: 'draft' }, error: null } }),
    )
    expect((await (await post({ journal_entry_id: JE_ID })).json()).error.code).toBe('LINK_TX_JE_NOT_POSTED')
  })

  it('dry run answers the projected link and writes nothing', async () => {
    const client = makeClient({
      company_members: OWNER,
      transactions: { data: txRow, error: null },
      journal_entries: { data: { id: JE_ID, status: 'posted', voucher_series: 'A', voucher_number: 12, entry_date: '2026-05-12' }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ journal_entry_id: JE_ID }, '?dry_run=true')
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toMatchObject({ journal_entry_id: JE_ID, voucher_label: 'A-12', invoice_id: null })
    expect(wrote(client)).toBe(false)
  })

  it('200 links the row to the posted verifikat', async () => {
    const client = makeClient({
      company_members: OWNER,
      transactions: [
        { data: txRow, error: null },
        { data: [{ id: TX_ID }], error: null },
      ],
      journal_entries: { data: { id: JE_ID, status: 'posted', voucher_series: 'A', voucher_number: 12, entry_date: '2026-05-12' }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ journal_entry_id: JE_ID })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ transaction_id: TX_ID, journal_entry_id: JE_ID, voucher_label: 'A-12' })
    expect(client.calls.find((c) => c.table === 'transactions' && c.method === 'update')?.args[0]).toMatchObject({ journal_entry_id: JE_ID })
  })
})

// ---------------------------------------------------------------------------

describe('POST /transactions/:id/match-batch', () => {
  const allocations = [
    { kind: 'customer_invoice', invoice_id: INV_ID, amount: 500 },
    { kind: 'customer_invoice', invoice_id: INV2_ID, amount: 750 },
  ]
  const post = (body: unknown, query = '') =>
    matchBatch(request(`${BASE}/${TX_ID}/match-batch${query}`, { method: 'POST', body: JSON.stringify(body) }), txParams())
  const invoices = { data: [
    { id: INV_ID, document_type: 'invoice', currency: 'SEK', exchange_rate: null, remaining_amount: 500, total: 500 },
    { id: INV2_ID, document_type: 'invoice', currency: 'SEK', exchange_rate: null, remaining_amount: 750, total: 750 },
  ], error: null }

  it('401 / 403 / 400 (mixed kinds, force without the reviewed set)', async () => {
    mockValidate.mockResolvedValueOnce({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await post({ allocations })).status).toBe(401)
    mockValidate.mockResolvedValueOnce({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:read'], mode: 'live' })
    expect((await post({ allocations })).status).toBe(403)
    expect((await post({ allocations: [allocations[0], { kind: 'supplier_invoice', supplier_invoice_id: INV2_ID, amount: 1 }] })).status).toBe(400)
    expect((await post({ allocations, force: true })).status).toBe(400)
  })

  it('refuses a proforma (MATCH_INVOICE_NOT_INVOICE_TYPE) before the RPC', async () => {
    const client = makeClient({ company_members: OWNER, invoices: { data: [{ id: INV_ID, document_type: 'proforma' }], error: null } })
    mockServiceClient.mockReturnValue(client)
    expect((await (await post({ allocations })).json()).error.code).toBe('MATCH_INVOICE_NOT_INVOICE_TYPE')
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('409 BATCH_TX_POSSIBLE_DUPLICATE when posted vouchers already explain the row', async () => {
    detectExplainingMock.mockResolvedValue({ vouchers: [{ journal_entry_id: JE_ID, voucher_label: 'A-3', amount: 1250, entry_date: '2026-05-12' }], total: 1250, amount: 1250 })
    const client = makeClient({ company_members: OWNER, invoices })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ allocations })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('BATCH_TX_POSSIBLE_DUPLICATE')
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('404 BATCH_TX_NOT_FOUND on a dry run for a row outside the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, invoices, transactions: { data: null, error: null } }))
    const res = await post({ allocations }, '?dry_run=true')
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('BATCH_TX_NOT_FOUND')
  })

  it('dry run projects the verifikat lines and writes nothing', async () => {
    const client = makeClient({
      company_members: OWNER,
      invoices,
      transactions: { data: { id: TX_ID, amount: 1250, currency: 'SEK', date: '2026-05-12', journal_entry_id: null }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ allocations }, '?dry_run=true')
    expect(res.status).toBe(200)
    const preview = (await res.json()).data.preview
    expect(preview).toMatchObject({ total_allocated: 1250, allocations_count: 2, expected_lines_balanced: true })
    expect(preview.expected_lines.length).toBeGreaterThan(0)
    expect(wrote(client)).toBe(false)
  })

  it('dry run refuses allocations that do not sum to the row', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: OWNER, invoices, transactions: { data: { id: TX_ID, amount: 1000, currency: 'SEK', date: '2026-05-12', journal_entry_id: null }, error: null } }),
    )
    expect((await (await post({ allocations }, '?dry_run=true')).json()).error.code).toBe('BATCH_AMOUNT_EXCEEDS_TX')
  })

  it('200 commits through the RPC with the API key user as actor', async () => {
    const client = makeClient({
      company_members: OWNER,
      invoices,
      'rpc:match_batch_allocate': {
        data: { ok: true, journal_entry_id: JE_ID, voucher_series: 'A', voucher_number: 12, tx_id: TX_ID, allocations: [], total_allocated: 1250, leftover: 0 },
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ allocations })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ journal_entry_id: JE_ID, voucher_number: 12, total_allocated: 1250 })
    expect(client.rpc).toHaveBeenCalledWith('match_batch_allocate', expect.objectContaining({ p_company_id: COMPANY_ID, p_user_id: 'user-1', p_tx_id: TX_ID }))
  })
})

// ---------------------------------------------------------------------------

describe('POST /transactions/bulk-book', () => {
  const post = (body: unknown, query = '') =>
    bulkBook(request(`${BASE}/bulk-book${query}`, { method: 'POST', body: JSON.stringify(body) }), companyParams)
  const rows = { data: [
    { id: TX_ID, amount: 100, currency: 'SEK', description: 'Swish 1', date: '2026-06-05', amount_sek: null, exchange_rate: null, cash_account_id: null },
    { id: TX2_ID, amount: 200, currency: 'SEK', description: 'Swish 2', date: '2026-06-05', amount_sek: null, exchange_rate: null, cash_account_id: null },
  ], error: null }
  const manual = {
    tx_ids: [TX_ID, TX2_ID],
    entry_description: 'Swish 2026-06-05',
    manual_lines: [
      { account_number: '1930', debit_amount: 300, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 300 },
    ],
  }

  it('401 / 403 / 400 (no path, two paths)', async () => {
    mockValidate.mockResolvedValueOnce({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await post(manual)).status).toBe(401)
    mockValidate.mockResolvedValueOnce({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:read'], mode: 'live' })
    expect((await post(manual)).status).toBe(403)
    expect((await post({ tx_ids: [TX_ID] })).status).toBe(400)
    expect((await post({ ...manual, existing_journal_entry_id: JE_ID })).status).toBe(400)
  })

  it('404 BULK_BOOK_TXS_NOT_FOUND when a row is outside the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, transactions: { data: [rows.data[0]], error: null } }))
    const res = await post(manual)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('BULK_BOOK_TXS_NOT_FOUND')
  })

  it('refuses foreign-currency batches (BULK_BOOK_FOREIGN_CURRENCY)', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: OWNER, transactions: { data: rows.data.map((r) => ({ ...r, currency: 'EUR' })), error: null } }),
    )
    expect((await (await post(manual)).json()).error.code).toBe('BULK_BOOK_FOREIGN_CURRENCY')
  })

  it('refuses accounts outside the chart (BULK_BOOK_INVALID_ACCOUNT)', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: OWNER, transactions: rows, chart_of_accounts: { data: [{ account_number: '1930' }], error: null } }),
    )
    const res = await post(manual)
    expect((await res.json()).error.code).toBe('BULK_BOOK_INVALID_ACCOUNT')
  })

  it('refuses another company\'s template (the RLS rule re-applied on the service role)', async () => {
    const client = makeClient({
      company_members: OWNER,
      transactions: rows,
      booking_template_library: { data: { id: JE_ID, lines: [], is_active: true, is_system: false, company_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', team_id: null }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ tx_ids: [TX_ID, TX2_ID], template_id: JE_ID, mode: 'sum_per_account', entry_description: 'x' })
    expect((await res.json()).error.code).toBe('BULK_BOOK_TEMPLATE_NOT_FOUND')
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('409 TRANSACTION_BOOK_POSSIBLE_DUPLICATE names the flagged row', async () => {
    detectDuplicateMock.mockResolvedValueOnce({ transaction_id: 'x', journal_entry_id: JE_ID })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, transactions: rows }))
    const res = await post(manual)
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('TRANSACTION_BOOK_POSSIBLE_DUPLICATE')
  })

  it('dry run answers the lines and the SEK sum, writes nothing', async () => {
    const client = makeClient({
      company_members: OWNER,
      transactions: rows,
      chart_of_accounts: { data: [{ account_number: '1930' }, { account_number: '3001' }], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post(manual, '?dry_run=true')
    expect(res.status).toBe(200)
    const preview = (await res.json()).data.preview
    expect(preview).toMatchObject({ mode: 'create_new', tx_count: 2, tx_sum: 300, currency: 'SEK' })
    expect(preview.lines).toHaveLength(2)
    expect(wrote(client)).toBe(false)
  })

  it('200 commits through the RPC with the API key user as actor', async () => {
    const client = makeClient({
      company_members: OWNER,
      transactions: rows,
      chart_of_accounts: { data: [{ account_number: '1930' }, { account_number: '3001' }], error: null },
      'rpc:bulk_book_transactions': {
        data: { ok: true, mode: 'create_new', journal_entry_id: JE_ID, voucher_series: 'A', voucher_number: 57, linked_tx_count: 2, tx_sum: 300, docs_linked: 0 },
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post(manual)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ journal_entry_id: JE_ID, voucher_number: 57, tx_sum: 300 })
    expect(client.rpc).toHaveBeenCalledWith('bulk_book_transactions', expect.objectContaining({ p_company_id: COMPANY_ID, p_user_id: 'user-1' }))
  })
})
