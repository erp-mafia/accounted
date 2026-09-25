/**
 * Supplier payment batches (betalfil) through the v1 door of the operation
 * registry (src/lib/operations/supplier-payment-batches.ts):
 *   POST /api/v1/companies/:companyId/supplier-payment-batches/preview
 *   POST /api/v1/companies/:companyId/supplier-payment-batches
 *   GET  /api/v1/companies/:companyId/supplier-payment-batches
 *   GET  /api/v1/companies/:companyId/supplier-payment-batches/:id
 *   GET  /api/v1/companies/:companyId/supplier-payment-batches/:id/file
 *   POST /api/v1/companies/:companyId/supplier-payment-batches/:id/cancel
 *
 * The rules under test are the services' (lib/payments/batch-service.ts and
 * batch-operations.ts): eligibility, the debtor check, the active-batch
 * collision, a dry run that writes nothing (no RPC, no MsgId), cancel's
 * compare-and-set, and the file download's stamp.
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

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { payeeFingerprint } from '@/lib/payments/batch-service'
import { GET as listBatches, POST as createBatch } from '../route'
import { POST as previewBatch } from '../preview/route'
import { GET as getBatch } from '../[id]/route'
import { GET as downloadFile } from '../[id]/file/route'
import { POST as cancelBatch } from '../[id]/cancel/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
}

/** Per-table queue mock that also records every (table, method, args). The last entry repeats. */
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
    calls.push({ table: 'rpc', method: String(args[0]), args })
    return buildChain('rpc')
  })
  return { calls, from: vi.fn((table: string) => buildChain(table)), rpc }
}

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])
/** Business tables only: withApiV1's own bookkeeping (idempotency, usage) is not the operation's. */
const BOOKS = new Set(['supplier_payment_batches', 'supplier_payment_batch_items', 'supplier_invoices'])
const wrote = (client: ReturnType<typeof makeClient>) =>
  client.calls.some((c) => (BOOKS.has(c.table) && WRITES.has(c.method)) || c.table === 'rpc')

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BATCH_ID = 'b1111111-1111-4111-8111-111111111111'
const INVOICE_A = '11111111-1111-4111-8111-111111111111'
const INVOICE_B = '22222222-2222-4222-8222-222222222222'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const MEMBER = { data: { company_id: COMPANY_ID, role: 'member' }, error: null }
const VIEWER = { data: { company_id: COMPANY_ID, role: 'viewer' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/supplier-payment-batches`

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
const batchParams = (id = BATCH_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, id }) })

const COMPANY = { data: { name: 'Testbolaget AB', org_number: '556677-8899' }, error: null }
const SETTINGS = {
  data: {
    company_name: 'Testbolaget AB',
    org_number: '556677-8899',
    city: 'Stockholm',
    iban: 'SE3550000000054910000003',
    bic: 'ESSESESS',
    bankgiro: null,
    clearing_number: null,
    bank_name: null,
  },
  error: null,
}

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_A,
    status: 'approved',
    approved_at: '2026-08-01T10:00:00Z',
    due_date: '2099-08-20',
    remaining_amount: 737.5,
    currency: 'SEK',
    is_credit_note: false,
    payment_reference: null,
    supplier_invoice_number: 'CD3014794407',
    supplier: {
      id: 'sup-1',
      name: 'Derome Bygg & Industri AB',
      city: 'Varberg',
      bankgiro: '5050-1055',
      plusgiro: null,
      bank_account: null,
      clearing_number: null,
      account_number: null,
    },
    ...overrides,
  }
}

function batchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BATCH_ID,
    company_id: COMPANY_ID,
    user_id: 'user-1',
    format: 'pain001',
    status: 'created',
    currency: 'SEK',
    total_amount: 737.5,
    item_count: 1,
    msg_id: 'ACCOUNTED-5566778899-BB1111111',
    debtor_snapshot: {
      name: 'Testbolaget AB',
      org_number: '556677-8899',
      iban: 'SE3550000000054910000003',
      bic: 'ESSESESS',
    },
    file_generated_at: null,
    download_count: 0,
    cancelled_at: null,
    cancelled_by: null,
    created_at: '2026-08-10T12:00:00Z',
    updated_at: '2026-08-10T12:00:00Z',
    ...overrides,
  }
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1111111-1111-4111-8111-111111111111',
    batch_id: BATCH_ID,
    company_id: COMPANY_ID,
    supplier_invoice_id: INVOICE_A,
    amount: 737.5,
    payment_date: '2026-08-15',
    payee_type: 'bankgiro',
    payee_bankgiro: '50501055',
    payee_plusgiro: null,
    payee_clearing: null,
    payee_account: null,
    payee_name: 'Derome Bygg & Industri AB',
    payee_city: 'Varberg',
    reference_type: 'invoice_number',
    reference: 'CD3014794407',
    created_at: '2026-08-10T12:00:00Z',
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
    scopes: ['suppliers:read', 'suppliers:write'],
    mode: 'live',
  })
})

// ─────────────────────────────────────────────────────────────────

describe('POST /supplier-payment-batches/preview', () => {
  const post = (body: unknown) =>
    previewBatch(request(`${BASE}/preview`, { method: 'POST', body: JSON.stringify(body) }), companyParams)

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post({ supplier_invoice_ids: [INVOICE_A] })).status).toBe(401)
  })

  it('403 without suppliers:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['invoices:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await post({ supplier_invoice_ids: [INVOICE_A] })).status).toBe(403)
  })

  it('400 on an empty id list or a non-uuid', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    const empty = await post({ supplier_invoice_ids: [] })
    expect(empty.status).toBe(400)
    expect((await empty.json()).error.code).toBe('VALIDATION_ERROR')
    expect((await post({ supplier_invoice_ids: ['nope'] })).status).toBe(400)
  })

  it('answers eligible and excluded lines with qualified ids, and writes nothing', async () => {
    const client = makeClient({
      company_members: MEMBER,
      supplier_invoices: { data: [invoiceRow()], error: null },
      supplier_payment_batch_items: { data: [], error: null },
      companies: COMPANY,
      company_settings: SETTINGS,
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ supplier_invoice_ids: [INVOICE_A, INVOICE_B] })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.eligible).toEqual([
      expect.objectContaining({
        supplier_invoice_id: INVOICE_A,
        amount: 737.5,
        payment_date: '2099-08-20',
        payee: { type: 'bankgiro', label: 'BG 5050-1055' },
        warnings: [],
        active_supplier_payment_batch_id: null,
      }),
    ])
    expect(body.data.excluded).toEqual([{ supplier_invoice_id: INVOICE_B, reason: 'not_found' }])
    expect(body.data).toMatchObject({ total_amount: 737.5, currency: 'SEK', debtor_ok: true, debtor_missing: null })
    expect(wrote(client)).toBe(false)
  })

  it('reports incomplete company bank details as debtor_missing', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: OWNER,
        supplier_invoices: { data: [invoiceRow()], error: null },
        supplier_payment_batch_items: { data: [], error: null },
        companies: COMPANY,
        company_settings: { data: { ...SETTINGS.data, iban: null }, error: null },
      }),
    )
    const body = await (await post({ supplier_invoice_ids: [INVOICE_A] })).json()
    expect(body.data).toMatchObject({ debtor_ok: false, debtor_missing: 'iban' })
  })
})

// ─────────────────────────────────────────────────────────────────

describe('POST /supplier-payment-batches', () => {
  const post = (body: unknown, query = '') =>
    createBatch(request(`${BASE}${query}`, { method: 'POST', body: JSON.stringify(body) }), companyParams)
  const eligibleClient = (overrides: Record<string, TableResp | TableResp[]> = {}) =>
    makeClient({
      company_members: MEMBER,
      companies: COMPANY,
      company_settings: SETTINGS,
      supplier_invoices: { data: [invoiceRow()], error: null },
      supplier_payment_batch_items: { data: [], error: null },
      rpc: { data: { ok: true, batch: batchRow() }, error: null },
      ...overrides,
    })

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post({ items: [{ supplier_invoice_id: INVOICE_A }] })).status).toBe(401)
  })

  it('403 without suppliers:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['suppliers:read'], mode: 'live' })
    const client = eligibleClient()
    mockServiceClient.mockReturnValue(client)
    expect((await post({ items: [{ supplier_invoice_id: INVOICE_A }] })).status).toBe(403)
    expect(wrote(client)).toBe(false)
  })

  it('403 for a viewer membership, writing nothing', async () => {
    const client = eligibleClient({ company_members: VIEWER })
    mockServiceClient.mockReturnValue(client)
    expect((await post({ items: [{ supplier_invoice_id: INVOICE_A }] })).status).toBe(403)
    expect(wrote(client)).toBe(false)
  })

  it('400 VALIDATION_ERROR on no items, a zero amount or a bad date', async () => {
    mockServiceClient.mockReturnValue(eligibleClient())
    const empty = await post({ items: [] })
    expect(empty.status).toBe(400)
    expect((await empty.json()).error.code).toBe('VALIDATION_ERROR')
    expect((await post({ items: [{ supplier_invoice_id: INVOICE_A, amount: 0 }] })).status).toBe(400)
    expect((await post({ items: [{ supplier_invoice_id: INVOICE_A, payment_date: '25/9' }] })).status).toBe(400)
  })

  it('201 for a member (the dashboard gates with requireWrite, not requireAdmin), through the RPC', async () => {
    const client = eligibleClient()
    mockServiceClient.mockReturnValue(client)
    const res = await post({ items: [{ supplier_invoice_id: INVOICE_A }] })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data).toEqual({
      supplier_payment_batch_id: BATCH_ID,
      msg_id: 'ACCOUNTED-5566778899-BB1111111',
      format: 'pain001',
      status: 'created',
      currency: 'SEK',
      total_amount: 737.5,
      item_count: 1,
      created_at: '2026-08-10T12:00:00Z',
      file: {
        filename: 'betalfil_20260810_b1111111.xml',
        download: '/api/v1/companies/{companyId}/supplier-payment-batches/{supplier_payment_batch_id}/file',
      },
    })
    expect(client.rpc).toHaveBeenCalledTimes(1)
    const [fn, args] = client.rpc.mock.calls[0] as [string, Record<string, unknown>]
    expect(fn).toBe('create_supplier_payment_batch')
    expect(args).toMatchObject({
      p_company_id: COMPANY_ID,
      p_format: 'pain001',
      p_user_id: 'user-1',
      p_confirm_already_batched: false,
      p_items: [expect.objectContaining({ supplier_invoice_id: INVOICE_A, amount: 737.5, payee_bankgiro: '50501055' })],
    })
    // Nothing is booked: no journal write of any kind.
    expect(client.calls.some((c) => c.table.startsWith('journal_'))).toBe(false)
  })

  it('a dry run previews the lines and writes nothing: no RPC, no MsgId', async () => {
    const client = eligibleClient()
    mockServiceClient.mockReturnValue(client)
    const res = await post({ items: [{ supplier_invoice_id: INVOICE_A, amount: 500 }] }, '?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({
      format: 'pain001',
      item_count: 1,
      total_amount: 500,
      items: [
        expect.objectContaining({
          supplier_invoice_id: INVOICE_A,
          amount: 500,
          payee: expect.objectContaining({ type: 'bankgiro', label: 'BG 5050-1055' }),
          reference: { type: 'invoice_number', value: 'CD3014794407' },
        }),
      ],
    })
    expect(body.data.preview.msg_id).toBeUndefined()
    expect(client.rpc).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('400 SI_BATCH_INELIGIBLE_INVOICE with the reason per invoice, writing nothing', async () => {
    const client = eligibleClient({ supplier_invoices: { data: [invoiceRow({ status: 'paid' })], error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ items: [{ supplier_invoice_id: INVOICE_A }, { supplier_invoice_id: INVOICE_B }] })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SI_BATCH_INELIGIBLE_INVOICE')
    expect(body.error.details.invoices).toEqual([
      { id: INVOICE_A, reason: 'not_payable' },
      { id: INVOICE_B, reason: 'not_found' },
    ])
    expect(wrote(client)).toBe(false)
  })

  it('400 SI_BATCH_AMOUNT_EXCEEDS_REMAINING above the remaining amount', async () => {
    const client = eligibleClient()
    mockServiceClient.mockReturnValue(client)
    const res = await post({ items: [{ supplier_invoice_id: INVOICE_A, amount: 800 }] })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('SI_BATCH_AMOUNT_EXCEEDS_REMAINING')
    expect(wrote(client)).toBe(false)
  })

  it('400 SI_BATCH_DEBTOR_INCOMPLETE names the missing company setting', async () => {
    const client = eligibleClient({ company_settings: { data: { ...SETTINGS.data, iban: null }, error: null } })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ items: [{ supplier_invoice_id: INVOICE_A }] })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('SI_BATCH_DEBTOR_INCOMPLETE')
    expect(body.error.details.missing).toBe('iban')
    expect(wrote(client)).toBe(false)
  })

  it('409 SI_BATCH_DUPLICATE_INVOICE for an invoice in an active batch, unless confirmed', async () => {
    const active = { data: [{ supplier_invoice_id: INVOICE_A, batch: { id: BATCH_ID, status: 'created' } }], error: null }
    const refused = eligibleClient({ supplier_payment_batch_items: active })
    mockServiceClient.mockReturnValue(refused)
    const res = await post({ items: [{ supplier_invoice_id: INVOICE_A }] })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('SI_BATCH_DUPLICATE_INVOICE')
    expect(body.error.details.invoices).toEqual([{ id: INVOICE_A, batch_id: BATCH_ID }])
    expect(wrote(refused)).toBe(false)

    const confirmed = eligibleClient({ supplier_payment_batch_items: active })
    mockServiceClient.mockReturnValue(confirmed)
    expect((await post({ items: [{ supplier_invoice_id: INVOICE_A }], confirm_already_batched: true })).status).toBe(201)
    expect((confirmed.rpc.mock.calls[0] as [string, Record<string, unknown>])[1].p_confirm_already_batched).toBe(true)
  })

  it('expected_payees locks a two-request flow: 409 SI_BATCH_PAYEE_CHANGED when the payee differs, 201 when it holds', async () => {
    const pinned = payeeFingerprint({ type: 'bankgiro', bankgiro: '50501055' })
    const stale = eligibleClient()
    mockServiceClient.mockReturnValue(stale)
    const refused = await post({
      items: [{ supplier_invoice_id: INVOICE_A }],
      expected_payees: [{ supplier_invoice_id: INVOICE_A, payee_fingerprint: payeeFingerprint({ type: 'bankgiro', bankgiro: '9999999' }), amount: 737.5 }],
    })
    expect(refused.status).toBe(409)
    const body = await refused.json()
    expect(body.error.code).toBe('SI_BATCH_PAYEE_CHANGED')
    expect(body.error.details.invoices).toEqual([{ id: INVOICE_A, supplier_name: 'Derome Bygg & Industri AB', changed: ['payee'] }])
    expect(wrote(stale)).toBe(false)

    const fresh = eligibleClient()
    mockServiceClient.mockReturnValue(fresh)
    const ok = await post({
      items: [{ supplier_invoice_id: INVOICE_A }],
      expected_payees: [{ supplier_invoice_id: INVOICE_A, payee_fingerprint: pinned, amount: 737.5 }],
    })
    expect(ok.status).toBe(201)
  })

  it('the dry run answers each line\'s payee fingerprint for expected_payees', async () => {
    mockServiceClient.mockReturnValue(eligibleClient())
    const body = await (await post({ items: [{ supplier_invoice_id: INVOICE_A }] }, '?dry_run=true')).json()
    expect(body.data.preview.items[0].payee.fingerprint).toBe(payeeFingerprint({ type: 'bankgiro', bankgiro: '50501055' }))
  })

  it('409 when the RPC finds the collision inside the transaction (race with another create)', async () => {
    const client = eligibleClient({
      rpc: { data: { ok: false, code: 'already_batched', details: [{ id: INVOICE_A, batch_id: BATCH_ID }] }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post({ items: [{ supplier_invoice_id: INVOICE_A }] })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('SI_BATCH_DUPLICATE_INVOICE')
  })
})

// ─────────────────────────────────────────────────────────────────

describe('GET /supplier-payment-batches', () => {
  const get = (query = '') => listBatches(request(`${BASE}${query}`), companyParams)

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await get()).status).toBe(401)
  })

  it('403 without suppliers:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['invoices:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await get()).status).toBe(403)
  })

  it('400 on an unknown status or an out-of-range limit', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await get('?status=paid')).status).toBe(400)
    expect((await get('?limit=500')).status).toBe(400)
  })

  it('lists newest first with settled_count, member ids and a next_cursor when the page is full', async () => {
    const older = batchRow({ id: 'b2222222-2222-4222-8222-222222222222', created_at: '2026-08-01T12:00:00Z', status: 'cancelled' })
    const client = makeClient({
      company_members: OWNER,
      supplier_payment_batches: { data: [batchRow(), older], error: null },
      supplier_payment_batch_items: {
        data: [{ batch_id: BATCH_ID, supplier_invoice_id: INVOICE_A, invoice: { remaining_amount: 0 } }],
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await get('?limit=1&status=all')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.supplier_payment_batches).toEqual([
      expect.objectContaining({
        supplier_payment_batch_id: BATCH_ID,
        status: 'created',
        settled_count: 1,
        supplier_invoice_ids: [INVOICE_A],
        download_count: 0,
      }),
    ])
    expect(body.data.supplier_payment_batches[0].debtor_snapshot).toBeUndefined()
    expect(typeof body.data.next_cursor).toBe('string')
    const limit = client.calls.find((c) => c.table === 'supplier_payment_batches' && c.method === 'limit')
    expect(limit?.args[0]).toBe(2)

    // The cursor resumes strictly after the last row returned.
    const next = makeClient({
      company_members: OWNER,
      supplier_payment_batches: { data: [older], error: null },
      supplier_payment_batch_items: { data: [], error: null },
    })
    mockServiceClient.mockReturnValue(next)
    const page2 = await (await get(`?limit=1&cursor=${body.data.next_cursor}`)).json()
    expect(page2.data.next_cursor).toBeNull()
    const or = next.calls.find((c) => c.table === 'supplier_payment_batches' && c.method === 'or')
    expect(String(or?.args[0])).toBe(
      `created_at.lt.2026-08-10T12:00:00Z,and(created_at.eq.2026-08-10T12:00:00Z,id.lt.${BATCH_ID})`,
    )
  })

  it('filters by status', async () => {
    const client = makeClient({
      company_members: OWNER,
      supplier_payment_batches: { data: [], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const body = await (await get('?status=created')).json()
    expect(body.data).toEqual({ supplier_payment_batches: [], next_cursor: null })
    const eq = client.calls.filter((c) => c.table === 'supplier_payment_batches' && c.method === 'eq')
    expect(eq.map((c) => c.args)).toContainEqual(['status', 'created'])
  })
})

// ─────────────────────────────────────────────────────────────────

describe('GET /supplier-payment-batches/:id', () => {
  const get = (id = BATCH_ID) => getBatch(request(`${BASE}/${id}`), batchParams(id))

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await get()).status).toBe(401)
  })

  it('403 without suppliers:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['invoices:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await get()).status).toBe(403)
  })

  it('400 on a non-uuid id', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await get('nope')).status).toBe(400)
  })

  it('404 SI_BATCH_NOT_FOUND for an unknown batch', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, supplier_payment_batches: { data: null, error: null } }))
    const res = await get()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('SI_BATCH_NOT_FOUND')
  })

  it('answers the lines with live invoice state and the file pointer', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: OWNER,
        supplier_payment_batches: { data: batchRow(), error: null },
        supplier_payment_batch_items: {
          data: [
            {
              ...itemRow(),
              invoice: { id: INVOICE_A, status: 'paid', remaining_amount: 0, supplier_invoice_number: 'CD3014794407', arrival_number: 12 },
            },
          ],
          error: null,
        },
      }),
    )
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({
      supplier_payment_batch_id: BATCH_ID,
      settled_count: 1,
      // The debtor IBAN is masked on this suppliers:read door; the file carries it in full.
      debtor: { name: 'Testbolaget AB', iban: 'SE35 **** 0003', bic: 'ESSESESS' },
      file: { filename: 'betalfil_20260810_b1111111.xml', content_type: 'application/xml', available: true },
    })
    expect(body.data.items).toEqual([
      expect.objectContaining({
        supplier_payment_batch_item_id: 'c1111111-1111-4111-8111-111111111111',
        supplier_invoice_id: INVOICE_A,
        payee: { type: 'bankgiro', label: 'BG 5050-1055' },
        invoice_status: 'paid',
        remaining_amount: 0,
        settled: true,
      }),
    ])
  })
})

// ─────────────────────────────────────────────────────────────────

describe('GET /supplier-payment-batches/:id/file', () => {
  const get = (id = BATCH_ID) => downloadFile(request(`${BASE}/${id}/file`), batchParams(id))

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await get()).status).toBe(401)
  })

  it('403 with only suppliers:read: the file is a payment instruction and the download is recorded', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['suppliers:read'], mode: 'live' })
    const client = makeClient({ company_members: OWNER, supplier_payment_batches: { data: batchRow(), error: null } })
    mockServiceClient.mockReturnValue(client)
    expect((await get()).status).toBe(403)
    expect(wrote(client)).toBe(false)
  })

  it('400 on a non-uuid id', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await get('nope')).status).toBe(400)
  })

  it('404 SI_BATCH_NOT_FOUND for an unknown batch', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, supplier_payment_batches: { data: null, error: null } }))
    expect((await get()).status).toBe(404)
  })

  it('409 SI_BATCH_CANCELLED for a cancelled batch, without stamping', async () => {
    const client = makeClient({
      company_members: OWNER,
      supplier_payment_batches: { data: batchRow({ status: 'cancelled' }), error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await get()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('SI_BATCH_CANCELLED')
    expect(wrote(client)).toBe(false)
  })

  it('answers the XML inline like the salary payment file, and stamps the download', async () => {
    const client = makeClient({
      company_members: MEMBER,
      supplier_payment_batches: [
        { data: batchRow({ download_count: 2 }), error: null },
        { data: null, error: null },
      ],
      supplier_payment_batch_items: { data: [itemRow()], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({
      supplier_payment_batch_id: BATCH_ID,
      format: 'pain001',
      filename: 'betalfil_20260810_b1111111.xml',
      content_type: 'application/xml',
      msg_id: 'ACCOUNTED-5566778899-BB1111111',
      item_count: 1,
      total_amount: 737.5,
      currency: 'SEK',
      download_count: 3,
    })
    expect(body.data.content).toContain('<MsgId>ACCOUNTED-5566778899-BB1111111</MsgId>')
    expect(body.data.sha256).toMatch(/^[0-9a-f]{64}$/)
    const stamp = client.calls.find((c) => c.table === 'supplier_payment_batches' && c.method === 'update')
    expect(stamp?.args[0]).toMatchObject({ download_count: 3 })
  })
})

// ─────────────────────────────────────────────────────────────────

describe('POST /supplier-payment-batches/:id/cancel', () => {
  const post = (id = BATCH_ID, query = '') =>
    cancelBatch(request(`${BASE}/${id}/cancel${query}`, { method: 'POST' }), batchParams(id))

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await post()).status).toBe(401)
  })

  it('403 without suppliers:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['suppliers:read'], mode: 'live' })
    const client = makeClient({ company_members: OWNER })
    mockServiceClient.mockReturnValue(client)
    expect((await post()).status).toBe(403)
    expect(wrote(client)).toBe(false)
  })

  it('400 on a non-uuid id', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER }))
    expect((await post('nope')).status).toBe(400)
  })

  it('404 SI_BATCH_NOT_FOUND when the batch does not exist', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: OWNER, supplier_payment_batches: { data: null, error: null } }))
    const res = await post()
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('SI_BATCH_NOT_FOUND')
  })

  it('cancels with a compare-and-set on status created, stamping who and when', async () => {
    const client = makeClient({
      company_members: MEMBER,
      supplier_payment_batches: { data: { id: BATCH_ID, status: 'cancelled', cancelled_at: '2026-09-25T10:00:00Z' }, error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      supplier_payment_batch_id: BATCH_ID,
      status: 'cancelled',
      cancelled_at: '2026-09-25T10:00:00Z',
    })
    const update = client.calls.find((c) => c.table === 'supplier_payment_batches' && c.method === 'update')
    expect(update?.args[0]).toMatchObject({ status: 'cancelled', cancelled_by: 'user-1' })
    const eq = client.calls.filter((c) => c.table === 'supplier_payment_batches' && c.method === 'eq').map((c) => c.args)
    expect(eq).toContainEqual(['status', 'created'])
  })

  it('409 SI_BATCH_ALREADY_CANCELLED when the compare-and-set matches nothing but the batch exists', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: OWNER,
        supplier_payment_batches: [
          { data: null, error: null },
          { data: { id: BATCH_ID, status: 'cancelled' }, error: null },
        ],
      }),
    )
    const res = await post()
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('SI_BATCH_ALREADY_CANCELLED')
  })

  it('a dry run reads the batch and writes nothing', async () => {
    const client = makeClient({
      company_members: OWNER,
      supplier_payment_batches: { data: batchRow({ download_count: 1 }), error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post(BATCH_ID, '?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({
      supplier_payment_batch_id: BATCH_ID,
      status: { from: 'created', to: 'cancelled' },
      file_downloaded: true,
    })
    expect(wrote(client)).toBe(false)
  })

  it('a dry run on a cancelled batch answers 409 like the live call', async () => {
    const client = makeClient({
      company_members: OWNER,
      supplier_payment_batches: { data: batchRow({ status: 'cancelled' }), error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await post(BATCH_ID, '?dry_run=true')
    expect(res.status).toBe(409)
    expect(wrote(client)).toBe(false)
  })
})
