/**
 * Integration tests for GET /api/v1/companies/:companyId/transactions
 * (list) and GET .../:id (detail).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(`tx route tests require NODE_ENV=test`)
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as listTransactions } from '../route'
import { GET as getTransaction } from '../[id]/route'
import { createTableMockSupabase } from '@/tests/helpers'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>


const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TX_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_ID = 'user-1'

function makeRequest(url: string): Request {
  return new Request(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['transactions:read'],
    mode: 'live',
  })
})

describe('GET /api/v1/companies/:companyId/transactions', () => {
  it('returns a list with pagination metadata', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: {
          data: [
            { id: TX_ID, date: '2026-05-12', amount: -100, currency: 'SEK', description: 'ICA' },
          ],
          error: null,
        },
      }).supabase,
    )

    const res = await listTransactions(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(1)
    // No next page → omitted (paginated() helper drops the key entirely
    // when nextCursor is undefined).
    expect(body.meta.next_cursor).toBeUndefined()
  })

  it('passes cash_account_id through as a filter and returns it on each row', async () => {
    const CASH_ACCOUNT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const { supabase, calls } = createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: {
        data: [
          {
            id: TX_ID, date: '2026-05-12', amount: -100, currency: 'SEK', description: 'ICA',
            cash_account_id: CASH_ACCOUNT_ID, created_at: '2026-05-12T10:00:00Z',
          },
        ],
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await listTransactions(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions?cash_account_id=${CASH_ACCOUNT_ID}`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data[0].cash_account_id).toBe(CASH_ACCOUNT_ID)
    const eqCalls = calls.filter((c) => c.table === 'transactions' && c.method === 'eq' && c.args[0] === 'cash_account_id')
    expect(eqCalls.map((c) => c.args[1])).toEqual([CASH_ACCOUNT_ID])
  })

  it('rejects a non-UUID cash_account_id filter with 400', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: { data: [], error: null },
      }).supabase,
    )
    const res = await listTransactions(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions?cash_account_id=1930`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(400)
  })

  it('rejects invalid status filter with 400', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }).supabase,
    )
    const res = await listTransactions(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions?status=unknown`,
      ),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(400)
  })

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(createTableMockSupabase({}).supabase)
    const res = await listTransactions(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions?status=unbooked`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(401)
  })

  // "Unbooked" is the work queue (decision 4): not ignored, not private, and
  // anchored to no verifikat. A bulk-booked (transaction_voucher_links) or
  // allocation-settled row keeps journal_entry_id NULL, so the pointer alone
  // listed it as unbooked and left it out of status=booked.
  async function listWithStatus(status: 'booked' | 'unbooked') {
    const { supabase, calls } = createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: { data: [], error: null },
    })
    mockServiceClient.mockReturnValue(supabase)
    const res = await listTransactions(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions?status=${status}`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    const filters = calls
      .filter((c) => c.table === 'transactions' && ['eq', 'not', 'is'].includes(c.method))
      .map((c) => [c.method, ...c.args])
    return { res, filters }
  }

  it('status=unbooked lists the work queue: no ignored, no private, no row anchored to a verifikat', async () => {
    const { res, filters } = await listWithStatus('unbooked')
    expect(res.status).toBe(200)
    expect(filters).toEqual(
      expect.arrayContaining([
        ['eq', 'is_ignored', false],
        ['not', 'is_business', 'is', false],
        ['eq', 'is_booked', false],
      ]),
    )
    expect(filters).not.toContainEqual(['is', 'journal_entry_id', null])
  })

  it('status=booked lists every row anchored to a verifikat, not only the journal_entry_id pointer', async () => {
    const { res, filters } = await listWithStatus('booked')
    expect(res.status).toBe(200)
    expect(filters).toContainEqual(['eq', 'is_booked', true])
    expect(filters).not.toContainEqual(['not', 'journal_entry_id', 'is', null])
  })

  it('rejects keys without transactions:read scope', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      scopes: ['invoices:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(createTableMockSupabase({}).supabase)
    const res = await listTransactions(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    expect(res.status).toBe(403)
  })
})

describe('GET /api/v1/companies/:companyId/transactions/:id', () => {
  it('returns 200 with the transaction and an empty split for a row without parts', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: {
          data: { id: TX_ID, date: '2026-05-12', amount: -100, currency: 'SEK' },
          error: null,
        },
        bank_transaction_parts: { data: [], error: null },
      }).supabase,
    )
    const res = await getTransaction(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}`),
      { params: Promise.resolve({ companyId: COMPANY_ID, id: TX_ID }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.parts).toEqual([])
  })

  it('names a foreign payment\'s payee by the IBAN the bank sent (PH 196)', async () => {
    const { supabase, calls } = createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: {
        data: { id: TX_ID, date: '2026-10-16', amount: -5000, currency: 'SEK', description: 'UTLANDSBETALNING', counterparty_account: null, counterparty_iban: 'NO9386011117947' },
        error: null,
      },
      bank_transaction_parts: { data: [], error: null },
    })
    mockServiceClient.mockReturnValue(supabase)
    const res = await getTransaction(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}`),
      { params: Promise.resolve({ companyId: COMPANY_ID, id: TX_ID }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ counterparty_account: null, counterparty_iban: 'NO9386011117947' })
    const select = calls.find((c) => c.table === 'transactions' && c.method === 'select')
    expect(String(select?.args[0])).toContain('counterparty_iban')
  })

  it('carries the Bankgirot split with the suggested invoice per part', async () => {
    const INV_1 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
    const INV_2 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2'
    const PART = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee'
    const { supabase, calls } = createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: {
        data: { id: TX_ID, date: '2026-10-12', amount: 1500, currency: 'SEK', potential_match_method: 'bankgiro_split' },
        error: null,
      },
      bank_transaction_parts: {
        data: [
          { id: `${PART}1`, company_id: COMPANY_ID, transaction_id: TX_ID, seq: 1, amount: '500.00', currency: 'SEK', counterparty_name: 'Kund AB', counterparty_org_number: '5560160680', counterparty_account: null, reference: '10017', invoice_numbers: [], message: null, provider_part_id: 'P1', suggested_invoice_id: INV_1, suggested_supplier_invoice_id: null, suggestion_reason: 'ocr_exact', created_at: '2026-10-12T05:00:00Z', updated_at: '2026-10-12T05:00:00Z' },
          { id: `${PART}2`, company_id: COMPANY_ID, transaction_id: TX_ID, seq: 2, amount: '1000.00', currency: 'SEK', counterparty_name: 'Bolaget AB', counterparty_org_number: null, counterparty_account: null, reference: null, invoice_numbers: ['1002'], message: 'Faktura 1002', provider_part_id: 'P2', suggested_invoice_id: INV_2, suggested_supplier_invoice_id: null, suggestion_reason: 'invoice_number', created_at: '2026-10-12T05:00:00Z', updated_at: '2026-10-12T05:00:00Z' },
        ],
        error: null,
      },
      invoices: {
        data: [
          { id: INV_1, invoice_number: '1001', remaining_amount: '500.00', currency: 'SEK', status: 'sent', customer: { name: 'Kund AB' } },
          { id: INV_2, invoice_number: '1002', remaining_amount: '1000.00', currency: 'SEK', status: 'sent', customer: { name: 'Bolaget AB' } },
        ],
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(supabase)
    const res = await getTransaction(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}`),
      { params: Promise.resolve({ companyId: COMPANY_ID, id: TX_ID }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.potential_match_method).toBe('bankgiro_split')
    expect(body.data.parts).toEqual([
      expect.objectContaining({ seq: 1, amount: 500, reference: '10017', suggestion_reason: 'ocr_exact', suggested_invoice: { kind: 'customer_invoice', invoice_id: INV_1, invoice_number: '1001', counterparty_name: 'Kund AB', remaining_amount: 500, currency: 'SEK' } }),
      expect.objectContaining({ seq: 2, amount: 1000, invoice_numbers: ['1002'], message: 'Faktura 1002', suggested_invoice: expect.objectContaining({ invoice_id: INV_2, invoice_number: '1002' }) }),
    ])
    // Parts and their invoices are read for this company only.
    const partsEq = calls.filter((c) => c.table === 'bank_transaction_parts' && c.method === 'eq').map((c) => c.args)
    expect(partsEq).toEqual([['company_id', COMPANY_ID], ['transaction_id', TX_ID]])
    const invoicesEq = calls.filter((c) => c.table === 'invoices' && c.method === 'eq').map((c) => c.args)
    expect(invoicesEq).toEqual([['company_id', COMPANY_ID]])
  })

  it('returns 404 NOT_FOUND for unknown id', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: { data: null, error: null },
      }).supabase,
    )
    const res = await getTransaction(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}`),
      { params: Promise.resolve({ companyId: COMPANY_ID, id: TX_ID }) },
    )
    expect(res.status).toBe(404)
  })

  it('rejects non-UUID id with 400', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }).supabase,
    )
    const res = await getTransaction(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/not-a-uuid`),
      { params: Promise.resolve({ companyId: COMPANY_ID, id: 'not-a-uuid' }) },
    )
    expect(res.status).toBe(400)
  })
})
