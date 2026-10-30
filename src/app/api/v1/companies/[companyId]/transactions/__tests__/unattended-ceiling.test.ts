/**
 * An API key's unattended ceiling on the v1 doors that book bank rows (#125):
 *   POST /transactions/:id/categorize      hand-written, posts through the engine
 *   POST /transactions/batch-categorize    hand-written, one verifikat per item
 *   POST /transactions/bulk-book           an operation door, a SQL posting function
 *
 * Before #125 only journal-entries/:id/commit and the staged-operation commit
 * read the ceiling, so these doors posted any amount for a capped key. The
 * routes still never read it: withApiV1 binds it to the request's commit
 * actor, and the engine (categorize) or the operation door (bulk-book)
 * refuses. The verifikat generator is stubbed, but it commits through the
 * REAL engine commitEntry, so the refusal comes from where it lives.
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
vi.mock('@/lib/events', () => ({ eventBus: { emit: vi.fn().mockResolvedValue(undefined) } }))
vi.mock('@/lib/events/bus', () => ({ eventBus: { emit: vi.fn().mockResolvedValue(undefined) } }))
vi.mock('@/lib/suggestion-log/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/suggestion-log/record')>()),
  snapshotSuggestions: vi.fn(async (_supabase: unknown, companyId: string) => ({ companyId, byTransaction: new Map() })),
  recordDecisions: vi.fn(async () => undefined),
}))
vi.mock('@/lib/bookkeeping/dimension-rules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/dimension-rules')>()),
  fetchActiveDimensionRules: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/bookkeeping/account-validation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/account-validation')>()),
  findUnresolvableAccounts: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/transactions/booking-duplicate-detection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/booking-duplicate-detection')>()),
  detectBookingDuplicate: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/transactions/inbox-underlag', () => ({
  propagateUnderlagForBookedTransaction: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/processing-history/append', () => ({ appendProcessingHistory: vi.fn().mockResolvedValue('evt-1') }))
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectExplainingVoucherSetForTransaction: vi.fn().mockResolvedValue(null),
}))

// The verifikat generator: builds the real lines, then commits the draft
// through the real engine door. `draftDebits` is what the draft's lines
// debit, read back by the engine's ceiling check.
const { draftDebits } = vi.hoisted(() => ({ draftDebits: new Map<string, number[]>() }))
vi.mock('@/lib/bookkeeping/transaction-entries', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/bookkeeping/transaction-entries')>()
  return {
    ...actual,
    createTransactionJournalEntry: vi.fn(
      async (
        supabase: Parameters<typeof actual.createTransactionJournalEntry>[0],
        companyId: string,
        userId: string,
        transaction: Parameters<typeof actual.buildTransactionEntryLines>[0],
        mapping: Parameters<typeof actual.buildTransactionEntryLines>[1],
      ) => {
        const draftId = `je-${transaction.id}`
        draftDebits.set(draftId, actual.buildTransactionEntryLines(transaction, mapping).map((l) => l.debit_amount))
        const { commitEntry } = await vi.importActual<typeof import('@/lib/bookkeeping/engine')>('@/lib/bookkeeping/engine')
        await commitEntry(supabase, companyId, userId, draftId)
        return { id: draftId }
      },
    ),
  }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { POST as categorize } from '../[id]/categorize/route'
import { POST as batchCategorize } from '../batch-categorize/route'
import { POST as bulkBook } from '../bulk-book/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TX_BIG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TX_SMALL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const JE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/transactions`
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }

const AMOUNTS: Record<string, number> = { [TX_BIG]: -12000, [TX_SMALL]: -349.5 }

function auth(unattendedCommitLimit: number | null) {
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'Bokföringsrobot',
    scopes: ['transactions:read', 'transactions:write'],
    mode: 'live',
    unattendedCommitLimit,
  })
}

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  })
}

const argOf = (calls: { method: string; args: unknown[] }[], column: string) =>
  calls.find((c) => c.method === 'eq' && c.args[0] === column)?.args[1]

/** One company's bank rows, read and compare-and-set by id; drafts' lines from draftDebits. */
function bankRowsClient() {
  const transactions: TableMockResolver = (calls) => {
    const id = argOf(calls, 'id') as string
    if (calls.some((c) => c.method === 'update')) return { data: [{ id }], error: null }
    return {
      data: { id, company_id: COMPANY_ID, date: '2026-05-12', amount: AMOUNTS[id], currency: 'SEK', merchant_name: 'Leverantör', cash_account_id: null, journal_entry_id: null },
      error: null,
    }
  }
  const lines: TableMockResolver = (calls) => ({
    data: (draftDebits.get(argOf(calls, 'journal_entry_id') as string) ?? []).map((debit_amount, i) => ({ id: `line-${i}`, debit_amount })),
    error: null,
  })
  const fiscalPeriods: TableMockResolver = (calls) =>
    calls.some((c) => c.method === 'limit')
      ? { data: [{ id: 'period-1' }], error: null }
      : { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null }
  return createTableMockSupabase({
    company_members: OWNER,
    company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
    transactions,
    journal_entry_lines: lines,
    fiscal_periods: fiscalPeriods,
  })
}

const committed = (rpc: ReturnType<typeof vi.fn>) =>
  rpc.mock.calls.filter(([name]) => name === 'commit_journal_entry').map(([, args]) => (args as { p_entry_id: string }).p_entry_id)

beforeEach(() => {
  vi.clearAllMocks()
  draftDebits.clear()
})

describe('POST /transactions/:id/categorize', () => {
  const send = (txId: string) =>
    categorize(post(`${BASE}/${txId}/categorize`, { is_business: true, category: 'expense_office' }), {
      params: Promise.resolve({ companyId: COMPANY_ID, id: txId }),
    })

  it('refuses a 12 000 kr booking on a key capped at 10 000: nothing posted, the row stays unbooked', async () => {
    auth(10000)
    const client = bankRowsClient()
    mockServiceClient.mockReturnValue(client.supabase)

    const res = await send(TX_BIG)
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.error.code).toBe('UNATTENDED_COMMIT_LIMIT_EXCEEDED')
    expect(body.error.details).toMatchObject({ attempted: 12000, limit: 10000 })
    expect(committed(client.supabase.rpc)).toEqual([])
    expect(client.payloads('transactions', 'update')).toEqual([])
  })

  it('refuses the dry run too, so its preview never promises the booking', async () => {
    auth(10000)
    const client = bankRowsClient()
    mockServiceClient.mockReturnValue(client.supabase)

    const res = await categorize(post(`${BASE}/${TX_BIG}/categorize?dry_run=true`, { is_business: true, category: 'expense_office' }), {
      params: Promise.resolve({ companyId: COMPANY_ID, id: TX_BIG }),
    })

    expect(res.status).toBe(403)
    expect((await res.json()).error.details).toMatchObject({ attempted: 12000, limit: 10000 })
  })

  it('books a 349,50 kr row on the same key', async () => {
    auth(10000)
    const client = bankRowsClient()
    mockServiceClient.mockReturnValue(client.supabase)

    const res = await send(TX_SMALL)

    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ journal_entry_created: true, journal_entry_id: `je-${TX_SMALL}` })
    expect(committed(client.supabase.rpc)).toEqual([`je-${TX_SMALL}`])
  })

  it('books any amount for a key without a ceiling', async () => {
    auth(null)
    const client = bankRowsClient()
    mockServiceClient.mockReturnValue(client.supabase)

    expect((await send(TX_BIG)).status).toBe(200)
    expect(committed(client.supabase.rpc)).toEqual([`je-${TX_BIG}`])
  })
})

describe('POST /transactions/batch-categorize', () => {
  it('refuses the item above the ceiling and books the one within it', async () => {
    auth(10000)
    const client = bankRowsClient()
    mockServiceClient.mockReturnValue(client.supabase)
    const categorization = { is_business: true, category: 'expense_office' }

    const res = await batchCategorize(
      post(`${BASE}/batch-categorize`, {
        items: [
          { transaction_id: TX_BIG, categorization },
          { transaction_id: TX_SMALL, categorization },
        ],
      }),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.summary).toEqual({ total: 2, succeeded: 1, failed: 1 })
    expect(body.data.results[0]).toMatchObject({
      ok: false,
      transaction_id: TX_BIG,
      error: { code: 'UNATTENDED_COMMIT_LIMIT_EXCEEDED', details: { attempted: 12000, limit: 10000 } },
    })
    expect(body.data.results[1]).toMatchObject({ ok: true, transaction_id: TX_SMALL })
    expect(committed(client.supabase.rpc)).toEqual([`je-${TX_SMALL}`])
  })
})

describe('POST /transactions/bulk-book', () => {
  const rows = {
    data: [
      { id: TX_BIG, amount: 100, currency: 'SEK', description: 'Swish 1', date: '2026-06-05', amount_sek: null, exchange_rate: null, cash_account_id: null },
      { id: TX_SMALL, amount: 200, currency: 'SEK', description: 'Swish 2', date: '2026-06-05', amount_sek: null, exchange_rate: null, cash_account_id: null },
    ],
    error: null,
  }
  const manual = {
    tx_ids: [TX_BIG, TX_SMALL],
    entry_description: 'Swish 2026-06-05',
    manual_lines: [
      { account_number: '1930', debit_amount: 300, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 300 },
    ],
  }
  const client = () =>
    createTableMockSupabase({
      company_members: OWNER,
      transactions: rows,
      chart_of_accounts: { data: [{ account_number: '1930' }, { account_number: '3001' }], error: null },
      'rpc:bulk_book_transactions': {
        data: { ok: true, mode: 'create_new', journal_entry_id: JE_ID, voucher_series: 'A', voucher_number: 57, linked_tx_count: 2, tx_sum: 300, docs_linked: 0 },
        error: null,
      },
      journal_entries: { data: { id: JE_ID, company_id: COMPANY_ID, status: 'posted', lines: [] }, error: null },
    })
  const send = (query = '') => bulkBook(post(`${BASE}/bulk-book${query}`, manual), { params: Promise.resolve({ companyId: COMPANY_ID }) })
  const booked = (rpc: ReturnType<typeof vi.fn>) => rpc.mock.calls.some(([name]) => name === 'bulk_book_transactions')

  it('refuses a 300 kr samlingsverifikat on a key capped at 200, priced as its staged twin', async () => {
    auth(200)
    const c = client()
    mockServiceClient.mockReturnValue(c.supabase)

    const res = await send()
    const body = await res.json()

    expect(res.status).toBe(403)
    expect(body.error.code).toBe('UNATTENDED_COMMIT_LIMIT_EXCEEDED')
    expect(body.error.details).toMatchObject({ attempted: 300, limit: 200, operation_type: 'bulk_book_transactions', stage_supported: true })
    expect(booked(c.supabase.rpc)).toBe(false)
  })

  it('refuses the dry run too, so a preview never promises what the key may not post', async () => {
    auth(200)
    const c = client()
    mockServiceClient.mockReturnValue(c.supabase)

    expect((await send('?dry_run=true')).status).toBe(403)
    expect(booked(c.supabase.rpc)).toBe(false)
  })

  it('books it on a key capped at 1 000', async () => {
    auth(1000)
    const c = client()
    mockServiceClient.mockReturnValue(c.supabase)

    const res = await send()

    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ journal_entry_id: JE_ID, tx_sum: 300 })
    expect(booked(c.supabase.rpc)).toBe(true)
  })
})

/**
 * Hard blocks on the same doors (accounted#130 step 2): a booking a booking
 * review rule matches is never booked from a key. The single door stages it
 * for a person (202), the batch door skips it, and when only the database
 * sees the match (commit_journal_entry's refusal) the single door still
 * stages it and nothing is posted.
 */
describe('booking review rules on the key doors', () => {
  const FROM_1000 = {
    id: 'r-1', rule_id: 'r-1', version: 1, accounts: null, counterparty_key: null, counterparty_label: null,
    amount_from_sek: 1000, vat_treatment: null, note: null, valid_from: '2026-10-29T00:00:00Z', created_by: 'u-1',
    created_at: '2026-10-29T00:00:00Z', revoked_at: null, revoked_by: null, revoked_reason: null,
  }
  const STAGED_ROW = {
    id: 'op-1', company_id: COMPANY_ID, operation_type: 'categorize_transaction', title: 'Kategorisera', status: 'pending',
    risk_level: 'medium', preview_data: {}, result_data: null, actor_type: 'api_key', actor_id: 'ak_1', actor_label: 'Bokföringsrobot',
    created_at: '2026-10-29T10:00:00Z', resolved_at: null,
  }
  const send = (txId: string) =>
    categorize(post(`${BASE}/${txId}/categorize`, { is_business: true, category: 'expense_office' }), {
      params: Promise.resolve({ companyId: COMPANY_ID, id: txId }),
    })

  it('stages a matched booking for a person instead of booking it, and answers 202', async () => {
    auth(null)
    const client = bankRowsClient()
    client.setTable('booking_review_rules', { data: [FROM_1000], error: null })
    client.setTable('pending_operations', { data: STAGED_ROW, error: null })
    mockServiceClient.mockReturnValue(client.supabase)

    const res = await send(TX_BIG)
    const body = await res.json()

    expect(res.status, JSON.stringify(body)).toBe(202)
    expect(body.data).toMatchObject({ pending_operation_id: 'op-1', status: 'pending', staged_because: 'BOOKING_REVIEW_REQUIRED' })
    const staged = client.payloads('pending_operations', 'insert')[0] as { operation_type: string; params: Record<string, unknown>; preview_data: { lines: unknown[] } }
    expect(staged.operation_type).toBe('categorize_transaction')
    expect(staged.params).toMatchObject({ transaction_id: TX_BIG, category: 'expense_office' })
    expect(staged.preview_data.lines.length).toBeGreaterThan(0)
    expect(committed(client.supabase.rpc)).toEqual([])
    expect(client.payloads('transactions', 'update')).toEqual([])
  })

  it('books a row the rule does not match on the same key', async () => {
    auth(null)
    const client = bankRowsClient()
    client.setTable('booking_review_rules', { data: [FROM_1000], error: null })
    mockServiceClient.mockReturnValue(client.supabase)

    expect((await send(TX_SMALL)).status).toBe(200)
    expect(committed(client.supabase.rpc)).toEqual([`je-${TX_SMALL}`])
  })

  it('skips the matched item of a batch and books the rest', async () => {
    auth(null)
    const client = bankRowsClient()
    client.setTable('booking_review_rules', { data: [FROM_1000], error: null })
    mockServiceClient.mockReturnValue(client.supabase)
    const categorization = { is_business: true, category: 'expense_office' }

    const res = await batchCategorize(
      post(`${BASE}/batch-categorize`, {
        items: [
          { transaction_id: TX_BIG, categorization },
          { transaction_id: TX_SMALL, categorization },
        ],
      }),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )
    const body = await res.json()

    expect(body.data.results[0]).toMatchObject({ ok: false, transaction_id: TX_BIG, error: { code: 'BOOKING_REVIEW_REQUIRED' } })
    expect(body.data.results[1]).toMatchObject({ ok: true, transaction_id: TX_SMALL })
    expect(committed(client.supabase.rpc)).toEqual([`je-${TX_SMALL}`])
  })

  it('stages it when only commit_journal_entry sees the match: the key never gets the reviewed commit', async () => {
    auth(null)
    const client = bankRowsClient()
    client.setTable('rpc:commit_journal_entry', {
      data: null,
      error: { message: 'BOOKING_REVIEW_REQUIRED: a booking review rule matches this booking', code: 'P0001' } as never,
    })
    client.setTable('pending_operations', { data: STAGED_ROW, error: null })
    mockServiceClient.mockReturnValue(client.supabase)

    const res = await send(TX_BIG)

    expect(res.status).toBe(202)
    expect(client.supabase.rpc.mock.calls.some(([name]) => name === 'commit_reviewed_journal_entry')).toBe(false)
    expect(client.payloads('transactions', 'update')).toEqual([])
  })

  it('refuses to link a matched row to a verifikat posted first: a key may not book it in two steps', async () => {
    auth(null)
    const c = createTableMockSupabase({
      company_members: OWNER,
      transactions: {
        data: [{ id: TX_BIG, amount: -1250, currency: 'SEK', description: 'Acme', merchant_name: 'Acme AB', date: '2026-06-05', amount_sek: null, exchange_rate: null, cash_account_id: null }],
        error: null,
      },
      booking_review_rules: { data: [{ ...FROM_1000, amount_from_sek: null, accounts: ['5410'] }], error: null },
      journal_entry_lines: {
        data: [
          { account_number: '5410', debit_amount: 1250, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 1250 },
        ],
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(c.supabase)

    const res = await bulkBook(post(`${BASE}/bulk-book`, { tx_ids: [TX_BIG], existing_journal_entry_id: JE_ID }), {
      params: Promise.resolve({ companyId: COMPANY_ID }),
    })
    const body = await res.json()

    expect(res.status, JSON.stringify(body)).toBe(409)
    expect(body.error.code).toBe('BOOKING_REVIEW_BULK_REFUSED')
    expect(c.supabase.rpc.mock.calls.some(([name]) => name === 'bulk_book_transactions')).toBe(false)
  })
})
