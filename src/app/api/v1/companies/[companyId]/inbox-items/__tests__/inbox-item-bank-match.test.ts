/**
 * Match on arrival through the v1 door (src/lib/operations/inbox-items.ts):
 * GET /inbox-items/{id} answers bank_match, the bank transaction the item
 * looks already paid by, re-checked on the read; a correction, a released
 * pairing and a new supplier look in the bank again
 * (lib/operations/inbox-bank-match.ts, mocked here: its own behaviour is
 * tested in lib/documents/bank-match). A dry run never looks.
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
vi.mock('@/lib/operations/inbox-bank-match', () => ({
  proposeBankMatchForInboxItem: vi.fn().mockResolvedValue(undefined),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { proposeBankMatchForInboxItem } from '@/lib/operations/inbox-bank-match'
import { bankMatchSourceKey, type BankMatchItemRow } from '@/lib/documents/inbox-bank-match'
import { GET as getItem, PATCH as patchItem } from '../[id]/route'
import { POST as unmatch } from '../[id]/unmatch-transaction/route'
import { POST as matchSupplier } from '../[id]/match-supplier/route'
import { createTableMockSupabase, type TableMockResult } from '@/tests/helpers'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockPropose = proposeBankMatchForInboxItem as ReturnType<typeof vi.fn>

/** The per-table mock (tests/helpers.ts) with its recorded calls, as the service client. */
function makeClient(byTable: Record<string, TableMockResult | TableMockResult[]>) {
  const { supabase, calls } = createTableMockSupabase(byTable)
  return Object.assign(supabase, { calls })
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ITEM_ID = '22222222-2222-4222-8222-222222222222'
const DOC_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const TX_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const SUPPLIER_ID = '33333333-3333-4333-8333-333333333333'
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

const itemParams = () => ({ params: Promise.resolve({ companyId: COMPANY_ID, id: ITEM_ID }) })

const READING = {
  supplier: { name: 'Kontorsbolaget AB' },
  invoice: { invoiceNumber: 'F-1', invoiceDate: '2026-09-01', dueDate: '2026-09-30', currency: 'SEK', paymentReference: '4711000123' },
  totals: { subtotal: 1000, vatAmount: 250, total: 1250 },
  documentKind: 'supplier_invoice',
}

function itemRow(overrides: Record<string, unknown> = {}) {
  const base = {
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
    email_from: 'faktura@kontorsbolaget.se',
    email_subject: 'Faktura F-1',
    email_received_at: '2026-09-02T07:41:02.000Z',
    email_body_text: null,
    error_message: null,
    kind_hint: null,
    channel_context: null,
    routed_to_arkiv_at: null,
    bank_match_transaction_id: null,
    bank_match_basis: null,
    bank_match_evidence_level: null,
    bank_match_source_key: null,
    ...overrides,
  }
  return base
}

/** An item carrying a proposal that still reads the same. */
function proposedRow(overrides: Record<string, unknown> = {}) {
  const row = itemRow({ bank_match_transaction_id: TX_ID, bank_match_basis: 'rule_ocr_reference', bank_match_evidence_level: 'exakt', ...overrides })
  return { ...row, bank_match_source_key: bankMatchSourceKey(row as BankMatchItemRow) }
}

function bankRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TX_ID,
    date: '2026-09-25',
    amount: -1250,
    currency: 'SEK',
    amount_sek: null,
    exchange_rate: null,
    description: 'Betalning',
    original_description: 'Betalning',
    merchant_name: 'KONTORSBOLAGET',
    reference: '4711000123',
    counterparty_account: null,
    journal_entry_id: null,
    is_ignored: false,
    invoice_id: null,
    supplier_invoice_id: null,
    receipt_id: null,
    document_id: null,
    potential_invoice_id: null,
    potential_supplier_invoice_id: null,
    potential_journal_entry_id: null,
    potential_rot_rut_payout_request_id: null,
    potential_match_method: null,
    transaction_voucher_links: [],
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
    scopes: ['documents:read', 'documents:write'],
    mode: 'live',
  })
})

describe('GET /inbox-items/:id bank_match', () => {
  const get = () => getItem(request(`${BASE}/${ITEM_ID}`, { method: 'GET' }), itemParams())

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    expect((await get()).status).toBe(401)
  })

  it('null for an item without a proposal, and no bank read for it', async () => {
    const client = makeClient({ company_members: MEMBER, invoice_inbox_items: { data: itemRow(), error: null } })
    mockServiceClient.mockReturnValue(client)
    const body = await (await get()).json()
    expect(body.data.bank_match).toBeNull()
    expect(client.calls.some((c) => c.table === 'transactions')).toBe(false)
  })

  it('answers the proposal with the bank row as it stands, never a score', async () => {
    const client = makeClient({
      company_members: MEMBER,
      invoice_inbox_items: [{ data: proposedRow(), error: null }, { data: [], error: null }],
      transactions: { data: bankRow(), error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).data.bank_match).toEqual({
      transaction_id: TX_ID,
      date: '2026-09-25',
      amount: -1250,
      currency: 'SEK',
      counterparty: 'KONTORSBOLAGET',
      basis: 'rule_ocr_reference',
      evidence_level: 'exakt',
    })
    expect(client.calls).toContainEqual(expect.objectContaining({ table: 'transactions', method: 'eq', args: ['company_id', COMPANY_ID] }))
  })

  it.each([
    ['its bank row was booked since', proposedRow(), bankRow({ journal_entry_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' })],
    ['its reading changed since', { ...proposedRow(), extracted_data: { ...READING, totals: { ...READING.totals, total: 999 } } }, bankRow()],
    ['it was converted to a supplier invoice', proposedRow({ created_supplier_invoice_id: '44444444-4444-4444-8444-444444444444' }), bankRow()],
  ])('null when %s', async (_label, row, tx) => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: MEMBER, invoice_inbox_items: [{ data: row, error: null }, { data: [], error: null }], transactions: { data: tx, error: null } }),
    )
    expect((await (await get()).json()).data.bank_match).toBeNull()
  })

  it('null, not a failed read, when the bank row cannot be read', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({ company_members: MEMBER, invoice_inbox_items: { data: proposedRow(), error: null }, transactions: { data: null, error: { message: 'statement timeout' } } }),
    )
    const res = await get()
    expect(res.status).toBe(200)
    expect((await res.json()).data.bank_match).toBeNull()
  })
})

describe('the doors that change what match on arrival compares look again', () => {
  it('a corrected reading does; its dry run does not', async () => {
    const client = makeClient({
      company_members: MEMBER,
      invoice_inbox_items: [{ data: itemRow(), error: null }, { data: { id: ITEM_ID, extracted_data: READING }, error: null }],
    })
    mockServiceClient.mockReturnValue(client)
    const patch = (query: string) =>
      patchItem(request(`${BASE}/${ITEM_ID}${query}`, { method: 'PATCH', body: JSON.stringify({ totals: { total: 500 } }) }), itemParams())

    expect((await patch('?dry_run=true')).status).toBe(200)
    expect(mockPropose).not.toHaveBeenCalled()

    expect((await patch('')).status).toBe(200)
    expect(mockPropose).toHaveBeenCalledWith(client, COMPANY_ID, ITEM_ID, expect.anything())
  })

  it('a released pairing does', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, invoice_inbox_items: { data: itemRow({ matched_transaction_id: TX_ID }), error: null } }))
    expect((await unmatch(request(`${BASE}/${ITEM_ID}/unmatch-transaction`, { method: 'POST' }), itemParams())).status).toBe(200)
    expect(mockPropose).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, ITEM_ID, expect.anything())
  })

  it('a newly matched supplier does', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        suppliers: { data: { id: SUPPLIER_ID, name: 'Kontorsbolaget AB' }, error: null },
        invoice_inbox_items: { data: itemRow(), error: null },
      }),
    )
    const res = await matchSupplier(
      request(`${BASE}/${ITEM_ID}/match-supplier`, { method: 'POST', body: JSON.stringify({ supplier_id: SUPPLIER_ID }) }),
      itemParams(),
    )
    expect(res.status).toBe(200)
    expect(mockPropose).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, ITEM_ID, expect.anything())
  })
})
