/**
 * Integration tests for POST /api/v1/companies/{companyId}/transactions/batch-categorize.
 *
 * Covers the missing-account guard: when a categorization references an
 * account that isn't active in the company's kontoplan, the per-item result
 * must surface as ACCOUNTS_NOT_IN_CHART without ever marking the row bokförd.
 * Other items in the same batch continue independently (partial-success
 * semantics).
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

const { createTxJE, findMissingAccountsMock, reverseEntryMock } = vi.hoisted(() => ({
  createTxJE: vi.fn().mockResolvedValue({ id: 'je-fresh' }),
  // Default: every mapped account resolves (active, or seedable standard
  // BAS). Per-test overrides simulate the bug surface (inactive/unknown).
  findMissingAccountsMock: vi.fn().mockResolvedValue([]),
  reverseEntryMock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/bookkeeping/transaction-entries', () => ({
  createTransactionJournalEntry: createTxJE,
}))
vi.mock('@/lib/bookkeeping/engine', () => ({
  reverseEntry: reverseEntryMock,
}))
vi.mock('@/lib/bookkeeping/account-validation', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/account-validation')>(
    '@/lib/bookkeeping/account-validation',
  )
  return {
    ...actual,
    findUnresolvableAccounts: findMissingAccountsMock,
  }
})
// category mapping is real: gives the route real BAS accounts to validate.

// Underlag propagation: mocked to assert the wiring (called once per item
// that actually booked); behavior is unit-tested in
// lib/transactions/__tests__/inbox-underlag.test.ts.
const { propagateUnderlagMock } = vi.hoisted(() => ({
  propagateUnderlagMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/transactions/inbox-underlag', () => ({
  propagateUnderlagForBookedTransaction: propagateUnderlagMock,
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { withUnusedVoucherAllocation } from '@/lib/bookkeeping/errors'
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

type MockResult = { data?: unknown; error?: unknown }
function makeFlexibleSupabase(byTable: Record<string, MockResult | MockResult[]>) {
  const queues = new Map<string, MockResult[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  // Insert payloads are recorded verbatim: the proxy would happily accept a
  // phantom column, so assertions have to inspect the object itself.
  const inserts: Record<string, unknown[]> = {}
  const updates: Record<string, unknown[]> = {}
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(table)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
            resolve(next)
          }
        }
        return (...args: unknown[]) => {
          if (prop === 'insert') (inserts[table] ??= []).push(args[0])
          if (prop === 'update') (updates[table] ??= []).push(args[0])
          return buildChain(table)
        }
      },
    }
    return new Proxy({}, handler)
  }
  return { supabase: { from: vi.fn((table: string) => buildChain(table)) }, inserts, updates }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TX_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TX_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function makeRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem1234-aaaa-4abc-8def-1234567890ab',
    },
    body: JSON.stringify(body),
  })
}
function batchParams() {
  return { params: Promise.resolve({ companyId: COMPANY_ID }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  findMissingAccountsMock.mockResolvedValue([])
  reverseEntryMock.mockResolvedValue(undefined)
  createTxJE.mockResolvedValue({ id: 'je-fresh' })
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['transactions:write'],
    mode: 'live',
  })
})

describe('POST batch-categorize', () => {
  it('atomically unignores ignored rows when categorizing them as private', async () => {
    const { supabase, updates } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: [
        {
          data: {
            id: TX_A,
            company_id: COMPANY_ID,
            date: '2026-05-12',
            amount: -349.5,
            currency: 'SEK',
            merchant_name: 'ICA',
            cash_account_id: null,
            journal_entry_id: null,
            is_ignored: true,
          },
          error: null,
        },
        { data: [{ id: TX_A }], error: null },
      ],
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        {
          items: [{ transaction_id: TX_A, categorization: { is_business: false } }],
        },
      ),
      batchParams(),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.summary).toEqual({ total: 1, succeeded: 1, failed: 0 })
    expect(updates.transactions).toContainEqual(
      expect.objectContaining({
        is_business: false,
        category: 'private',
        is_ignored: false,
        journal_entry_id: 'je-fresh',
      }),
    )
  })

  it('maps the ignored-row constraint to a typed per-item error', async () => {
    const { supabase } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: [
        {
          data: {
            id: TX_A,
            company_id: COMPANY_ID,
            date: '2026-05-12',
            amount: -349.5,
            currency: 'SEK',
            merchant_name: 'ICA',
            cash_account_id: null,
            journal_entry_id: null,
            is_ignored: true,
          },
          error: null,
        },
        {
          data: null,
          error: {
            code: '23514',
            message:
              'new row for relation "transactions" violates check constraint "transactions_is_ignored_no_journal_entry"',
          },
        },
      ],
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        {
          items: [{ transaction_id: TX_A, categorization: { is_business: false } }],
        },
      ),
      batchParams(),
    )

    const body = await res.json()
    expect(body.data.results[0].error).toMatchObject({
      code: 'TX_CATEGORIZE_IGNORED_CONFLICT',
      message:
        'Transaktionen är fortfarande markerad som ignorerad och kan därför inte kopplas till en verifikation.',
    })
    expect(body.data.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
    expect(reverseEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      'user-1',
      'je-fresh',
    )
  })

  it('returns a per-item NO_OPEN_PERIOD_FOR_DATE and writes nothing when the engine finds no covering period', async () => {
    const { supabase, updates } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: {
        data: {
          id: TX_A,
          company_id: COMPANY_ID,
          date: '2026-05-12',
          amount: -349.5,
          currency: 'SEK',
          merchant_name: 'ICA',
          journal_entry_id: null,
        },
        error: null,
      },
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)
    createTxJE.mockResolvedValueOnce(null)

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        {
          items: [{ transaction_id: TX_A, categorization: { is_business: true, category: 'expense_office' } }],
        },
      ),
      batchParams(),
    )

    const body = await res.json()
    expect(body.data.results[0].ok).toBe(false)
    expect(body.data.results[0].error.code).toBe('NO_OPEN_PERIOD_FOR_DATE')
    expect(body.data.results[0].error.details.transaction_date).toBe('2026-05-12')
    expect(body.data.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
    // Refused before the CAS write (issue #1947): no update, no orphan, no storno.
    expect(updates.transactions).toBeUndefined()
    expect(reverseEntryMock).not.toHaveBeenCalled()
  })

  it('keeps unrelated transaction update errors mapped to INTERNAL_ERROR', async () => {
    const { supabase } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: [
        {
          data: {
            id: TX_A,
            company_id: COMPANY_ID,
            date: '2026-05-12',
            amount: -349.5,
            currency: 'SEK',
            merchant_name: 'ICA',
            cash_account_id: null,
            journal_entry_id: null,
          },
          error: null,
        },
        {
          data: null,
          error: { code: 'P0001', message: 'Invoice not found' },
        },
      ],
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        {
          items: [{ transaction_id: TX_A, categorization: { is_business: false } }],
        },
      ),
      batchParams(),
    )

    const body = await res.json()
    expect(body.data.results[0].error.code).toBe('INTERNAL_ERROR')
    expect(reverseEntryMock).toHaveBeenCalledTimes(1)
  })

  it('uses the linked cash account in validation and the posted mapping', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: {
          data: {
            id: TX_A,
            company_id: COMPANY_ID,
            date: '2026-05-12',
            amount: -349.5,
            currency: 'SEK',
            merchant_name: 'ICA',
            cash_account_id: 'cash-1',
            journal_entry_id: null,
          },
          error: null,
        },
        company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
        cash_accounts: { data: { ledger_account: '1931' }, error: null },
        fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
      }).supabase,
    )

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        {
          items: [
            { transaction_id: TX_A, categorization: { is_business: true, category: 'expense_office' } },
          ],
        },
      ),
      batchParams(),
    )

    expect(res.status).toBe(200)
    expect(findMissingAccountsMock).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      expect.arrayContaining(['1931']),
    )
    expect(createTxJE).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      'user-1',
      expect.objectContaining({ id: TX_A, cash_account_id: 'cash-1' }),
      expect.objectContaining({ credit_account: '1931' }),
    )
  })

  it('propagates underlag once per item that actually booked, not for already-booked items', async () => {
    const txRow = (id: string, journalEntryId: string | null) => ({
      data: {
        id,
        company_id: COMPANY_ID,
        date: '2026-05-12',
        amount: -100,
        currency: 'SEK',
        merchant_name: 'ICA',
        cash_account_id: null,
        journal_entry_id: journalEntryId,
      },
      error: null,
    })
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: [
          txRow(TX_A, null), // item A fetch: unbooked
          { data: [{ id: TX_A }], error: null }, // item A CAS update: owned
          txRow(TX_B, 'je-old'), // item B fetch: already booked
          { data: null, error: null }, // item B flags-flip update
        ],
        company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
        fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
      }).supabase,
    )

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        {
          items: [
            { transaction_id: TX_A, categorization: { is_business: true, category: 'expense_office' } },
            { transaction_id: TX_B, categorization: { is_business: true, category: 'expense_office' } },
          ],
        },
      ),
      batchParams(),
    )

    expect(res.status).toBe(200)
    // Only the item whose CAS write this batch owns gets the propagation;
    // the already-booked item was consumed by whatever booked it earlier.
    expect(propagateUnderlagMock).toHaveBeenCalledTimes(1)
    expect(propagateUnderlagMock).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      TX_A,
      'je-fresh',
    )
  })

  it('isolates a settlement lookup failure to its item and continues the batch', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: [
          {
            data: {
              id: TX_A,
              company_id: COMPANY_ID,
              date: '2026-05-12',
              amount: -100,
              currency: 'SEK',
              cash_account_id: 'cash-broken',
              journal_entry_id: null,
            },
            error: null,
          },
          {
            data: {
              id: TX_B,
              company_id: COMPANY_ID,
              date: '2026-05-13',
              amount: -200,
              currency: 'SEK',
              cash_account_id: 'cash-ok',
              journal_entry_id: null,
            },
            error: null,
          },
        ],
        company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
        cash_accounts: [
          { data: null, error: { message: 'temporary lookup failure' } },
          { data: { ledger_account: '1931' }, error: null },
        ],
        fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
      }).supabase,
    )

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        {
          items: [
            { transaction_id: TX_A, categorization: { is_business: true, category: 'expense_office' } },
            { transaction_id: TX_B, categorization: { is_business: true, category: 'expense_office' } },
          ],
        },
      ),
      batchParams(),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.results[0].ok).toBe(false)
    expect(body.data.results[0].error.code).toBe('INTERNAL_ERROR')
    expect(body.data.results[1].ok).toBe(true)
    expect(body.data.summary).toEqual({ total: 2, succeeded: 1, failed: 1 })
    expect(createTxJE).toHaveBeenCalledTimes(1)
    expect(createTxJE).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      'user-1',
      expect.objectContaining({ id: TX_B }),
      expect.objectContaining({ credit_account: '1931' }),
    )
  })

  it('returns per-item ACCOUNTS_NOT_IN_CHART for items whose mapping references inactive accounts; clean items still succeed', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        // Each `transactions` lookup returns the same shape; the flexible
        // proxy serves both items from this single result. amount is < 0 so
        // both map to an expense flow.
        transactions: {
          data: {
            company_id: COMPANY_ID,
            date: '2026-05-12',
            amount: -349.5,
            currency: 'SEK',
            merchant_name: 'ICA',
            journal_entry_id: null,
          },
          error: null,
        },
        company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
        fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
      }).supabase,
    )

    // First item: mapping references an inactive account. Second item: clean.
    findMissingAccountsMock
      .mockResolvedValueOnce(['5410'])
      .mockResolvedValueOnce([])

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        {
          items: [
            { transaction_id: TX_A, categorization: { is_business: true, category: 'expense_office' } },
            { transaction_id: TX_B, categorization: { is_business: true, category: 'expense_office' } },
          ],
        },
      ),
      batchParams(),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.results).toHaveLength(2)
    expect(body.data.results[0].ok).toBe(false)
    expect(body.data.results[0].request_index).toBe(0)
    expect(body.data.results[0].error.code).toBe('ACCOUNTS_NOT_IN_CHART')
    expect(body.data.results[0].error.details.account_numbers).toEqual(['5410'])
    expect(body.data.results[1].ok).toBe(true)
    expect(body.data.results[1].request_index).toBe(1)
    expect(body.data.summary).toEqual({ total: 2, succeeded: 1, failed: 1 })

    // Engine must only be called for the clean item.
    expect(createTxJE).toHaveBeenCalledTimes(1)
  })

  it('returns ACCOUNTS_NOT_IN_CHART when the engine throws AccountsNotInChartError mid-flight (defense in depth)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: {
          data: {
            company_id: COMPANY_ID,
            date: '2026-05-12',
            amount: -349.5,
            currency: 'SEK',
            merchant_name: 'ICA',
            journal_entry_id: null,
          },
          error: null,
        },
        company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
        fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
      }).supabase,
    )
    // Pre-validation passes: race where an account got deactivated between
    // our chart_of_accounts read and the engine's resolveAccountIds read.
    findMissingAccountsMock.mockResolvedValueOnce([])
    const { AccountsNotInChartError } = await import('@/lib/bookkeeping/errors')
    createTxJE.mockRejectedValueOnce(new AccountsNotInChartError(['5410']))

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        {
          items: [
            { transaction_id: TX_A, categorization: { is_business: true, category: 'expense_office' } },
          ],
        },
      ),
      batchParams(),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.results).toHaveLength(1)
    expect(body.data.results[0].ok).toBe(false)
    expect(body.data.results[0].error.code).toBe('ACCOUNTS_NOT_IN_CHART')
    expect(body.data.results[0].error.details.account_numbers).toEqual(['5410'])
    expect(body.data.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
  })

  it('refuses the item and writes nothing when the journal entry cannot be created, while a clean sibling still books (issue #1947)', async () => {
    const { supabase, updates } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: [
        // 1: item A fetch. 2: item B fetch. 3: item B CAS update (item A
        // never reaches its update: the refusal returns first).
        {
          data: {
            company_id: COMPANY_ID,
            date: '2026-05-12',
            amount: -349.5,
            currency: 'SEK',
            merchant_name: 'ICA',
            journal_entry_id: null,
          },
          error: null,
        },
        {
          data: {
            company_id: COMPANY_ID,
            date: '2026-05-13',
            amount: -120,
            currency: 'SEK',
            merchant_name: 'Coop',
            journal_entry_id: null,
          },
          error: null,
        },
        { data: [{ id: TX_B }], error: null },
      ],
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)
    const { BookkeepingDatabaseError } = await import('@/lib/bookkeeping/errors')
    createTxJE.mockRejectedValueOnce(
      new BookkeepingDatabaseError('commit_entry', 'Cannot write to locked/closed fiscal period "2026"'),
    )

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        {
          items: [
            { transaction_id: TX_A, categorization: { is_business: true, category: 'expense_office' } },
            { transaction_id: TX_B, categorization: { is_business: true, category: 'expense_office' } },
          ],
        },
      ),
      batchParams(),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.results).toHaveLength(2)
    expect(body.data.results[0].ok).toBe(false)
    expect(body.data.results[0].transaction_id).toBe(TX_A)
    expect(body.data.results[0].error.code).toBe('TX_CATEGORIZE_JOURNAL_ENTRY_FAILED')
    expect(body.data.results[0].error.message).toBe(
      'Perioden är låst. Verifikationen kan inte skapas i en stängd eller låst period.',
    )
    expect(body.data.results[0].error.details.cause).toBe('BOOKKEEPING_DATABASE_ERROR')
    expect(body.data.results[1].ok).toBe(true)
    expect(body.data.results[1].data.journal_entry_id).toBe('je-fresh')
    expect(body.data.summary).toEqual({ total: 2, succeeded: 1, failed: 1 })

    // Only the clean sibling reached the transactions update: the refused
    // item stays uncategorized so it remains in the unbooked queue.
    expect(updates.transactions).toHaveLength(1)
    expect(updates.transactions[0]).toEqual(
      expect.objectContaining({ is_business: true, journal_entry_id: 'je-fresh' }),
    )
    expect(propagateUnderlagMock).toHaveBeenCalledTimes(1)
    expect(propagateUnderlagMock).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, TX_B, 'je-fresh')
  })

  it('documents the stranded voucher with the real voucher_gap_explanations columns when the CAS-race storno fails', async () => {
    const { supabase, inserts } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: [
        // 1: item fetch. 2: the CAS update, which matches no row because a
        // concurrent request already stamped journal_entry_id.
        {
          data: {
            company_id: COMPANY_ID,
            date: '2026-05-12',
            amount: -349.5,
            currency: 'SEK',
            merchant_name: 'ICA',
            journal_entry_id: null,
          },
          error: null,
        },
        { data: [], error: null },
      ],
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
      journal_entries: {
        data: { fiscal_period_id: 'period-1', voucher_series: 'B', voucher_number: 42 },
        error: null,
      },
      voucher_gap_explanations: { data: null, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)
    // The reversal sequence allocation fails before a reversal row is stored,
    // so the engine exposes the exact unused number for documentation.
    reverseEntryMock.mockRejectedValueOnce(
      withUnusedVoucherAllocation(new Error('account lookup failed'), {
        fiscalPeriodId: 'period-1',
        voucherSeries: 'B',
        voucherNumber: 43,
      }),
    )

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        {
          items: [
            { transaction_id: TX_A, categorization: { is_business: true, category: 'expense_office' } },
          ],
        },
      ),
      batchParams(),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.results[0].error.code).toBe('TX_CATEGORIZE_RACE')

    const gaps = inserts['voucher_gap_explanations'] as Record<string, unknown>[]
    expect(gaps).toHaveLength(1)
    // Exhaustive: no gap_number, no created_by, and every NOT NULL column set.
    expect(gaps[0]).toEqual({
      company_id: COMPANY_ID,
      user_id: 'user-1',
      fiscal_period_id: 'period-1',
      voucher_series: 'B',
      gap_start: 43,
      gap_end: 43,
      explanation:
        'Kategoriseringsverifikation utan transaktionskoppling; automatisk storno misslyckades. Manuell avstämning krävs.',
    })
  })
})
