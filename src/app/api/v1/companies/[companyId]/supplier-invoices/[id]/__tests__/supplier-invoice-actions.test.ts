/**
 * Supplier-invoice actions through the v1 door of the operation registry
 * (src/lib/operations/supplier-invoice-actions.ts via lib/operations/v1.ts):
 *   DELETE /api/v1/companies/:companyId/supplier-invoices/:id
 *   POST   /api/v1/companies/:companyId/supplier-invoices/:id/uncredit
 *   PATCH  /api/v1/companies/:companyId/supplier-invoices/:id/items/:itemId
 *   POST   /api/v1/companies/:companyId/supplier-invoices/:id/bank-entered
 *
 * The rules under test are the services' (lib/supplier-invoices/manage.ts,
 * item-account.ts): a booked invoice is never deleted, the credit note's
 * verifikat is cancelled with a storno (never edited), a posted registration
 * verifikat is corrected only through the inline rättelse RPC, and a dry run
 * writes nothing.
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
const reverseEntryMock = vi.fn()
vi.mock('@/lib/bookkeeping/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>('@/lib/bookkeeping/engine')
  return { ...actual, reverseEntry: (...args: unknown[]) => reverseEntryMock(...args) }
})
const backfillMock = vi.fn()
vi.mock('@/lib/bookkeeping/account-backfill', () => ({
  backfillStandardBASAccounts: (...args: unknown[]) => backfillMock(...args),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { DELETE as deleteInvoice } from '../route'
import { POST as uncredit } from '../uncredit/route'
import { PATCH as moveItem } from '../items/[itemId]/route'
import { POST as bankEntered } from '../bank-entered/route'

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
  return { calls, from: vi.fn((table: string) => buildChain(table)), rpc }
}

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])
const BOOKS = new Set(['supplier_invoices', 'supplier_invoice_items', 'journal_entries', 'journal_entry_lines', 'chart_of_accounts'])
const wrote = (client: ReturnType<typeof makeClient>) =>
  client.calls.some((c) => (BOOKS.has(c.table) && WRITES.has(c.method)) || c.method === 'rpc')

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SI_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CREDIT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ITEM_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const JE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const LINE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/supplier-invoices/${SI_ID}`

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

const params = (id = SI_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })
const itemParams = { params: Promise.resolve({ companyId: COMPANY_ID, id: SI_ID, itemId: ITEM_ID }) }

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: SI_ID,
    company_id: COMPANY_ID,
    arrival_number: 118,
    supplier_invoice_number: '55012',
    status: 'registered',
    invoice_date: '2026-09-03',
    due_date: '2099-10-03',
    currency: 'SEK',
    total: 6250,
    remaining_amount: 6250,
    is_credit_note: false,
    registration_journal_entry_id: null,
    bank_entered_at: null,
    payments: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  backfillMock.mockResolvedValue(undefined)
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['suppliers:write'],
    mode: 'live',
  })
})

describe('DELETE /api/v1/companies/:companyId/supplier-invoices/:id', () => {
  const del = (query = '', id = SI_ID) => deleteInvoice(request(`${BASE}${query}`, { method: 'DELETE' }), params(id))

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await del()).status).toBe(401)
  })

  it('403 without suppliers:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['suppliers:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await del()).status).toBe(403)
  })

  it('400 VALIDATION_ERROR for an id that is not a uuid', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    const res = await del('', 'not-a-uuid')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('404 SI_NOT_FOUND for an invoice outside the company', async () => {
    const client = makeClient({ company_members: OWNER, supplier_invoices: { data: null, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await del()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('SI_NOT_FOUND')
    expect(client.calls).toContainEqual({ table: 'supplier_invoices', method: 'eq', args: ['company_id', COMPANY_ID] })
  })

  it('refuses a credit note (400 SI_DELETE_CREDIT_NOTE) and writes nothing', async () => {
    const client = makeClient({ company_members: OWNER, supplier_invoices: { data: invoice({ is_credit_note: true }) } })
    mockServiceClient.mockReturnValue(client)
    const res = await del()
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('SI_DELETE_CREDIT_NOTE')
    expect(wrote(client)).toBe(false)
  })

  it('refuses a booked invoice: a posted verifikat is never deleted', async () => {
    const client = makeClient({
      company_members: OWNER,
      supplier_invoices: { data: invoice({ status: 'approved', registration_journal_entry_id: JE_ID }) },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await del()
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SI_DELETE_HAS_BOOKING')
    expect(body.error.details.reason).toBe('registration_journal_entry')
    expect(wrote(client)).toBe(false)
  })

  it('refuses a paid invoice (400 SI_DELETE_INVALID_STATUS)', async () => {
    const client = makeClient({ company_members: OWNER, supplier_invoices: { data: invoice({ status: 'paid' }) } })
    mockServiceClient.mockReturnValue(client)
    const res = await del()
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('SI_DELETE_INVALID_STATUS')
  })

  it('refuses an invoice in a payment batch (409) and writes nothing', async () => {
    const client = makeClient({
      company_members: OWNER,
      supplier_invoices: { data: invoice() },
      supplier_payment_batch_items: { data: { id: 'x', batch_id: 'batch-1' } },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await del()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('SI_DELETE_IN_PAYMENT_BATCH')
    expect(wrote(client)).toBe(false)
  })

  it('a dry run previews the delete and writes nothing', async () => {
    const client = makeClient({ company_members: OWNER, supplier_invoices: { data: invoice() } })
    mockServiceClient.mockReturnValue(client)
    const res = await del('?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({ supplier_invoice_id: SI_ID, arrival_number: 118 })
    expect(wrote(client)).toBe(false)
  })

  it('deletes an unbooked invoice and its lines', async () => {
    const client = makeClient({ company_members: OWNER, supplier_invoices: { data: invoice({ status: 'overdue' }) } })
    mockServiceClient.mockReturnValue(client)
    const res = await del()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ supplier_invoice_id: SI_ID, deleted: true })
    expect(client.calls.some((c) => c.table === 'supplier_invoice_items' && c.method === 'delete')).toBe(true)
    expect(client.calls.some((c) => c.table === 'supplier_invoices' && c.method === 'delete')).toBe(true)
  })
})

describe('POST /api/v1/companies/:companyId/supplier-invoices/:id/uncredit', () => {
  const post = (query = '') => uncredit(request(`${BASE}/uncredit${query}`, { method: 'POST' }), params())

  it('404 SI_NOT_FOUND for an unknown invoice', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, supplier_invoices: { data: null, error: null } }))
    const res = await post()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('SI_NOT_FOUND')
  })

  it('is an idempotent no-op on an invoice that is not credited', async () => {
    const client = makeClient({ company_members: OWNER, supplier_invoices: { data: invoice({ status: 'approved' }) } })
    mockServiceClient.mockReturnValue(client)
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ changed: false, reversal_entry_id: null })
    expect(reverseEntryMock).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('a dry run names the storno and the restored status, posting nothing', async () => {
    const client = makeClient({
      company_members: OWNER,
      supplier_invoices: [
        { data: invoice({ status: 'credited', registration_journal_entry_id: JE_ID, remaining_amount: 0 }) },
        { data: { id: CREDIT_ID, registration_journal_entry_id: JE_ID } },
      ],
      journal_entries: { data: { status: 'posted', entry_date: '2026-09-10', voucher_series: 'A', voucher_number: 42 } },
      company_settings: { data: { bookkeeping_locked_through: null } },
      fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null } },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post('?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview).toMatchObject({
      credit_note_id: CREDIT_ID,
      posts_storno: true,
      credit_voucher: 'A42',
      restored_status: 'approved',
      remaining_amount: 6250,
    })
    expect(reverseEntryMock).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('a dry run refuses a credit verifikat in a locked period (PERIOD_LOCKED)', async () => {
    const client = makeClient({
      company_members: OWNER,
      supplier_invoices: [
        { data: invoice({ status: 'credited', registration_journal_entry_id: JE_ID }) },
        { data: { id: CREDIT_ID, registration_journal_entry_id: JE_ID } },
      ],
      journal_entries: { data: { status: 'posted', entry_date: '2026-01-10', voucher_series: 'A', voucher_number: 3 } },
      company_settings: { data: { bookkeeping_locked_through: '2026-03-31' } },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post('?dry_run=true')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('PERIOD_LOCKED')
  })

  it('cancels the credit verifikat with a storno, keeps the credit row as reversed, restores the original', async () => {
    reverseEntryMock.mockResolvedValue({ id: 'storno-1' })
    const client = makeClient({
      company_members: OWNER,
      supplier_invoices: [
        { data: invoice({ status: 'credited', registration_journal_entry_id: JE_ID, remaining_amount: 0 }) },
        { data: { id: CREDIT_ID, registration_journal_entry_id: 'credit-je' } },
        { data: null, error: null },
        { data: invoice({ status: 'approved', registration_journal_entry_id: JE_ID }) },
      ],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({
      changed: true,
      reversal_entry_id: 'storno-1',
      reversed_credit_note_id: CREDIT_ID,
      supplier_invoice: { supplier_invoice_id: SI_ID, status: 'approved' },
    })
    expect(reverseEntryMock).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, 'user-1', 'credit-je')
    const updates = client.calls.filter((c) => c.table === 'supplier_invoices' && c.method === 'update')
    expect(updates[0]!.args[0]).toMatchObject({ status: 'reversed' })
    expect(updates[1]!.args[0]).toEqual({ status: 'approved', remaining_amount: 6250 })
    // Never a delete: the credit row stays for the archive.
    expect(client.calls.some((c) => c.method === 'delete')).toBe(false)
  })
})

describe('PATCH /api/v1/companies/:companyId/supplier-invoices/:id/items/:itemId', () => {
  const patch = (body: unknown, query = '') =>
    moveItem(request(`${BASE}/items/${ITEM_ID}${query}`, { method: 'PATCH', body: JSON.stringify(body) }), itemParams)

  it('400 VALIDATION_ERROR for a malformed account number', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    const res = await patch({ account_number: '65' })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('404 SI_ITEM_NOT_FOUND for a line not on the invoice', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: OWNER, supplier_invoices: { data: invoice() }, supplier_invoice_items: { data: null } }),
    )
    const res = await patch({ account_number: '6550' })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('SI_ITEM_NOT_FOUND')
  })

  it('409 SI_ITEM_ACCOUNT_SETTLED on a paid invoice', async () => {
    const client = makeClient({ company_members: OWNER, supplier_invoices: { data: invoice({ status: 'paid' }) } })
    mockServiceClient.mockReturnValue(client)
    const res = await patch({ account_number: '6550' })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('SI_ITEM_ACCOUNT_SETTLED')
    expect(wrote(client)).toBe(false)
  })

  it('moves the line of an unbooked invoice without touching any verifikat', async () => {
    const client = makeClient({
      company_members: OWNER,
      supplier_invoices: { data: invoice() },
      supplier_invoice_items: [
        { data: { id: ITEM_ID, account_number: '6580', line_total: 500, description: 'Juridik' } },
        { data: [{ id: ITEM_ID }] },
      ],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await patch({ account_number: '6550' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ changed: true, corrected: false })
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('corrects a posted registration verifikat inline through correct_entry_lines_inline', async () => {
    const client = makeClient({
      company_members: OWNER,
      supplier_invoices: { data: invoice({ status: 'approved', registration_journal_entry_id: JE_ID }) },
      supplier_invoice_items: [
        { data: { id: ITEM_ID, account_number: '6580', line_total: 500, description: 'Juridik' } },
        { data: [{ id: ITEM_ID }] },
      ],
      journal_entry_lines: { data: [{ id: LINE_ID, account_number: '6580', debit_amount: 500, credit_amount: 0, line_description: null }] },
      rpc: { data: { ok: true }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await patch({ account_number: '6550' })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ changed: true, corrected: true })
    expect(client.rpc).toHaveBeenCalledWith(
      'correct_entry_lines_inline',
      expect.objectContaining({
        p_company_id: COMPANY_ID,
        p_entry_id: JE_ID,
        p_strike_line_ids: [LINE_ID],
        p_user_id: 'user-1',
      }),
    )
  })

  it('reverts the line when the verifikat holds no matching line (409)', async () => {
    const client = makeClient({
      company_members: OWNER,
      supplier_invoices: { data: invoice({ status: 'approved', registration_journal_entry_id: JE_ID }) },
      supplier_invoice_items: [
        { data: { id: ITEM_ID, account_number: '6580', line_total: 500, description: 'Juridik' } },
        { data: [{ id: ITEM_ID }] },
        { data: null },
      ],
      journal_entry_lines: { data: [{ id: LINE_ID, account_number: '5420', debit_amount: 500, credit_amount: 0, line_description: null }] },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await patch({ account_number: '6550' })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('SI_ITEM_ACCOUNT_NO_MATCHING_LINE')
    const updates = client.calls.filter((c) => c.table === 'supplier_invoice_items' && c.method === 'update')
    expect(updates.map((u) => u.args[0])).toEqual([{ account_number: '6550' }, { account_number: '6580' }])
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('a dry run plans the rättelse, calls no RPC and writes nothing (not even the account backfill)', async () => {
    const client = makeClient({
      company_members: OWNER,
      supplier_invoices: { data: invoice({ status: 'approved', registration_journal_entry_id: JE_ID }) },
      supplier_invoice_items: { data: { id: ITEM_ID, account_number: '6580', line_total: 500, description: 'Juridik' } },
      journal_entry_lines: [
        { data: [{ id: LINE_ID, account_number: '6580', debit_amount: 500, credit_amount: 0, line_description: null }] },
        {
          data: [
            { id: LINE_ID, account_number: '6580', debit_amount: 500, credit_amount: 0, line_description: null, currency: 'SEK', dimensions: {}, sort_order: 0 },
            { id: 'l2', account_number: '2440', debit_amount: 0, credit_amount: 500, line_description: null, currency: 'SEK', dimensions: {}, sort_order: 1 },
          ],
        },
      ],
      journal_entries: {
        data: {
          id: JE_ID,
          status: 'posted',
          description: 'Leverantörsfaktura',
          entry_date: '2026-09-03',
          source_type: 'supplier_invoice_registered',
          fiscal_period_id: 'fp-1',
          voucher_series: 'A',
          voucher_number: 7,
        },
      },
      fiscal_periods: { data: { is_closed: false, locked_at: null, period_start: '2026-01-01', period_end: '2026-12-31', opening_balance_entry_id: null } },
      company_settings: { data: { bookkeeping_locked_through: null } },
      chart_of_accounts: { data: [{ account_number: '6550', is_active: true }] },
      document_attachments: { data: [] },
      transactions: { data: [] },
      transaction_voucher_links: { data: [] },
      invoice_payments: { data: [] },
      supplier_invoice_payments: { data: [] },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await patch({ account_number: '6550' }, '?dry_run=true')
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.preview).toMatchObject({ old_account: '6580', new_account: '6550', corrects_verifikat: true, journal_entry_id: JE_ID })
    expect(client.rpc).not.toHaveBeenCalled()
    expect(backfillMock).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })
})

describe('POST /api/v1/companies/:companyId/supplier-invoices/:id/bank-entered', () => {
  const post = (body: unknown, query = '') =>
    bankEntered(request(`${BASE}/bank-entered${query}`, { method: 'POST', body: JSON.stringify(body) }), params())

  it('400 VALIDATION_ERROR without a boolean', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await post({ entered: 'yes' })).status).toBe(400)
  })

  it('400 SI_BANK_ENTERED_NOT_PAYABLE on a registered (unattested) invoice', async () => {
    const client = makeClient({ company_members: OWNER, supplier_invoices: { data: invoice({ status: 'registered' }) } })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ entered: true })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('SI_BANK_ENTERED_NOT_PAYABLE')
    expect(wrote(client)).toBe(false)
  })

  it('marks an approved invoice, with a compare-and-set on its eligibility', async () => {
    const client = makeClient({
      company_members: OWNER,
      supplier_invoices: [{ data: invoice({ status: 'approved' }) }, { data: { id: SI_ID, bank_entered_at: '2026-09-06T10:00:00.000Z' } }],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ entered: true })
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ supplier_invoice_id: SI_ID, bank_entered_at: '2026-09-06T10:00:00.000Z' })
    expect(client.calls).toContainEqual({ table: 'supplier_invoices', method: 'in', args: ['status', ['approved', 'overdue', 'partially_paid']] })
  })

  it('a dry run writes nothing', async () => {
    const client = makeClient({ company_members: OWNER, supplier_invoices: { data: invoice({ status: 'approved' }) } })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ entered: true }, '?dry_run=true')
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toMatchObject({ changed: true, entered: true })
    expect(wrote(client)).toBe(false)
  })
})
