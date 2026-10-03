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
// One test swaps in a fixed mapping (a plain 2440 supplier payment, which no
// category or booking template produces today) through this override; every
// other test delegates to the real builder.
const { categoryMappingOverride } = vi.hoisted(() => ({
  categoryMappingOverride: { current: null as null | ((...args: unknown[]) => unknown) },
}))
vi.mock('@/lib/bookkeeping/category-mapping', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/bookkeeping/category-mapping')>()
  return {
    ...actual,
    buildMappingResultFromCategory: (...args: Parameters<typeof actual.buildMappingResultFromCategory>) =>
      categoryMappingOverride.current
        ? categoryMappingOverride.current(...args)
        : actual.buildMappingResultFromCategory(...args),
  }
})

// Underlag propagation: mocked to assert the wiring (called once per item
// that actually booked); behavior is unit-tested in
// lib/transactions/__tests__/inbox-underlag.test.ts.
const { propagateUnderlagMock } = vi.hoisted(() => ({
  propagateUnderlagMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/transactions/inbox-underlag', () => ({
  propagateUnderlagForBookedTransaction: propagateUnderlagMock,
}))
// Booking-time duplicate guard: the DB-backed detector is stubbed ("no
// duplicate" by default) so it never consumes the queued `transactions`
// results the tests below script; the detection queries are unit-tested in
// lib/transactions/__tests__/booking-duplicate-detection.test.ts.
const { detectDupMock, appendHistoryMock } = vi.hoisted(() => ({
  detectDupMock: vi.fn(),
  appendHistoryMock: vi.fn(),
}))
vi.mock('@/lib/transactions/booking-duplicate-detection', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/transactions/booking-duplicate-detection')>()),
  detectBookingDuplicate: detectDupMock,
}))
vi.mock('@/lib/processing-history/append', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/processing-history/append')>()),
  appendProcessingHistory: appendHistoryMock,
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
  detectDupMock.mockReset().mockResolvedValue(null)
  appendHistoryMock.mockReset().mockResolvedValue('evt-1')
  categoryMappingOverride.current = null
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

  it('answers a private marking in a locked period with TX_CATEGORIZE_PRIVATE_PERIOD_LOCKED, a business one with PERIOD_LOCKED (issue #1661)', async () => {
    const { supabase, updates } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: {
        data: {
          id: TX_A,
          company_id: COMPANY_ID,
          date: '2025-11-12',
          amount: -349.5,
          currency: 'SEK',
          merchant_name: 'SWISH DUBBLETT',
          journal_entry_id: null,
        },
        error: null,
      },
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      fiscal_periods: { data: { id: 'period-2025', is_closed: true, locked_at: null }, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
        {
          items: [
            { transaction_id: TX_A, categorization: { is_business: false } },
            { transaction_id: TX_B, categorization: { is_business: true, category: 'expense_office' } },
          ],
        },
      ),
      batchParams(),
    )

    const body = await res.json()
    expect(body.data.results[0].ok).toBe(false)
    expect(body.data.results[0].error.code).toBe('TX_CATEGORIZE_PRIVATE_PERIOD_LOCKED')
    expect(body.data.results[0].error.message).toContain('Ignorera')
    expect(body.data.results[0].error.details).toMatchObject({
      transaction_date: '2025-11-12',
      reason: 'period_is_closed',
      fiscal_period_id: 'period-2025',
      suggested_action: 'ignore',
    })
    expect(body.data.results[1].ok).toBe(false)
    expect(body.data.results[1].error.code).toBe('PERIOD_LOCKED')
    expect(body.data.results[1].error.details.suggested_action).toBeUndefined()
    expect(body.data.summary).toEqual({ total: 2, succeeded: 0, failed: 2 })
    // Neither item reached the engine or the CAS write.
    expect(createTxJE).not.toHaveBeenCalled()
    expect(updates.transactions).toBeUndefined()
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
        cash_accounts: { data: { ledger_account: '1931', currency: 'SEK' }, error: null },
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
          { data: { ledger_account: '1931', currency: 'SEK' }, error: null },
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

  // VAT registration: the batch route loads company_settings.vat_registered
  // once and hands it to every item's mapping, so a non-registered company
  // books no moms line (lib/bookkeeping/vat-registration.ts).
  it.each([
    { vat_registered: false, vatLineCount: 0 },
    { vat_registered: true, vatLineCount: 1 },
  ])(
    'books a company with vat_registered = $vat_registered with $vatLineCount moms line(s)',
    async ({ vat_registered, vatLineCount }) => {
      const { supabase } = makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: [
          {
            data: {
              id: TX_A,
              company_id: COMPANY_ID,
              date: '2026-05-12',
              amount: -1250,
              currency: 'SEK',
              merchant_name: 'Adobe',
              cash_account_id: null,
              journal_entry_id: null,
              is_ignored: false,
            },
            error: null,
          },
          { data: [{ id: TX_A }], error: null },
        ],
        company_settings: { data: { entity_type: 'ideell_forening', vat_registered }, error: null },
        fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
      })
      mockServiceClient.mockReturnValue(supabase)

      const res = await POST(
        makeRequest(
          `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`,
          { items: [{ transaction_id: TX_A, categorization: { is_business: true, category: 'expense_software' } }] },
        ),
        batchParams(),
      )

      expect(res.status).toBe(200)
      expect(createTxJE).toHaveBeenCalledTimes(1)
      const mapping = createTxJE.mock.calls[0][4] as { debit_account: string; vat_lines: unknown[] }
      expect(mapping.debit_account).toBe('5420')
      expect(mapping.vat_lines).toHaveLength(vatLineCount)
    },
  )
})

describe('POST batch-categorize double-booking guards (parity with :categorize and the dashboard route)', () => {
  const URL = `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`
  const EXISTING_JE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const candidate = {
    transaction_id: null,
    journal_entry_id: EXISTING_JE,
    voucher_label: 'A12',
    entry_date: '2026-05-12',
    description: 'Leverantörsfaktura 100 betald',
    amount: -100,
    account_number: '1930',
    currency: null,
    amount_in_currency: null,
    amount_verified: true,
    unverified_reason: null,
  }
  const txRow = (id: string, overrides: Record<string, unknown> = {}) => ({
    data: {
      id,
      company_id: COMPANY_ID,
      date: '2026-05-12',
      amount: -100,
      currency: 'SEK',
      merchant_name: 'ICA',
      cash_account_id: null,
      journal_entry_id: null,
      ...overrides,
    },
    error: null,
  })

  it('returns 401 without a valid bearer token', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}).supabase)

    const res = await POST(
      makeRequest(URL, {
        items: [{ transaction_id: TX_A, categorization: { is_business: true, category: 'expense_office' } }],
      }),
      batchParams(),
    )

    expect(res.status).toBe(401)
    expect(createTxJE).not.toHaveBeenCalled()
  })

  it('returns 400 for an item with force=true but no reviewed candidate id', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }).supabase,
    )

    const res = await POST(
      makeRequest(URL, {
        items: [
          {
            transaction_id: TX_A,
            categorization: { is_business: true, category: 'expense_office', force: true },
          },
        ],
      }),
      batchParams(),
    )

    expect(res.status).toBe(400)
    expect(createTxJE).not.toHaveBeenCalled()
  })

  it('refuses an already-booked bank line per item with TRANSACTION_BOOK_POSSIBLE_DUPLICATE while a clean sibling books', async () => {
    const { supabase, updates } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: [
        txRow(TX_A), // item A fetch: its bank line is already booked by a voucher
        txRow(TX_B), // item B fetch: clean
        { data: [{ id: TX_B }], error: null }, // item B CAS update: owned
      ],
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)
    detectDupMock.mockResolvedValueOnce(candidate).mockResolvedValueOnce(null)

    const res = await POST(
      makeRequest(URL, {
        items: [
          { transaction_id: TX_A, categorization: { is_business: true, category: 'expense_office' } },
          { transaction_id: TX_B, categorization: { is_business: true, category: 'expense_office' } },
        ],
      }),
      batchParams(),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.summary).toEqual({ total: 2, succeeded: 1, failed: 1 })
    expect(body.data.results[0]).toEqual(
      expect.objectContaining({
        ok: false,
        transaction_id: TX_A,
        error: expect.objectContaining({
          code: 'TRANSACTION_BOOK_POSSIBLE_DUPLICATE',
          details: { candidate: expect.objectContaining({ journal_entry_id: EXISTING_JE }) },
        }),
      }),
    )
    expect(body.data.results[1]).toEqual(expect.objectContaining({ ok: true, transaction_id: TX_B }))
    // Only item B reached the engine and the transaction write.
    expect(createTxJE).toHaveBeenCalledTimes(1)
    expect(updates.transactions).toHaveLength(1)
  })

  it('never dedupes an item against a verifikat booked earlier in the same batch', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: [
          txRow(TX_A),
          { data: [{ id: TX_A }], error: null },
          txRow(TX_B),
          { data: [{ id: TX_B }], error: null },
        ],
        company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
        fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
      }).supabase,
    )
    createTxJE.mockResolvedValueOnce({ id: 'je-a' }).mockResolvedValueOnce({ id: 'je-b' })

    const res = await POST(
      makeRequest(URL, {
        items: [
          { transaction_id: TX_A, categorization: { is_business: true, category: 'expense_office' } },
          { transaction_id: TX_B, categorization: { is_business: true, category: 'expense_office' } },
        ],
      }),
      batchParams(),
    )

    expect(res.status).toBe(200)
    expect(detectDupMock).toHaveBeenCalledTimes(2)
    expect(detectDupMock.mock.calls[0][3]).toEqual({ excludeTransactionIds: [], excludeJournalEntryIds: [] })
    expect(detectDupMock.mock.calls[1][3]).toEqual({
      excludeTransactionIds: [TX_A],
      excludeJournalEntryIds: ['je-a'],
    })
  })

  it('books an item over its candidate with a bound force and records the dismissal', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: [txRow(TX_A), { data: [{ id: TX_A }], error: null }],
        company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
        fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
      }).supabase,
    )
    detectDupMock.mockResolvedValue(candidate)

    const res = await POST(
      makeRequest(URL, {
        items: [
          {
            transaction_id: TX_A,
            categorization: {
              is_business: true,
              category: 'expense_office',
              force: true,
              expected_duplicate_journal_entry_id: EXISTING_JE,
            },
          },
        ],
      }),
      batchParams(),
    )

    expect(res.status).toBe(200)
    expect((await res.json()).data.summary).toEqual({ total: 1, succeeded: 1, failed: 0 })
    expect(createTxJE).toHaveBeenCalledTimes(1)
    expect(appendHistoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'BankTransactionDuplicateDismissed',
        aggregateId: TX_A,
        payload: expect.objectContaining({
          dismissed_journal_entry_id: EXISTING_JE,
          via: 'api_force',
        }),
      }),
    )
  })

  it('refuses a plain 244x supplier payment an open supplier invoice covers, unless confirm_no_match', async () => {
    const supplierSupabase = () =>
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: [
          txRow(TX_A, { amount: -1250, merchant_name: 'Kontorsbolaget' }),
          { data: [{ id: TX_A }], error: null },
        ],
        company_settings: { data: { entity_type: 'aktiebolag' }, error: null },
        suppliers: { data: [{ id: 'sup-1' }], error: null },
        supplier_invoices: {
          data: [
            {
              id: 'si-1',
              supplier_invoice_number: 'F-100',
              invoice_date: '2026-04-30',
              remaining_amount: 1250,
              total: 1250,
              currency: 'SEK',
              total_sek: 1250,
              exchange_rate: null,
              supplier: { name: 'Kontorsbolaget AB' },
            },
          ],
          error: null,
        },
        fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
      })
    categoryMappingOverride.current = () => ({
      rule: null,
      debit_account: '2440',
      credit_account: '1930',
      risk_level: 'NONE',
      confidence: 1,
      requires_review: false,
      default_private: false,
      vat_lines: [],
      description: 'Leverantörsbetalning',
    })
    const categorization = { is_business: true, category: 'expense_other' }

    mockServiceClient.mockReturnValue(supplierSupabase().supabase)
    const refused = await POST(
      makeRequest(URL, { items: [{ transaction_id: TX_A, categorization }] }),
      batchParams(),
    )
    const refusedBody = await refused.json()
    expect(refusedBody.data.results[0].error.code).toBe('TX_CATEGORIZE_SUGGEST_SI_MATCH')
    expect(refusedBody.data.results[0].error.details.candidates[0].supplier_invoice_id).toBe('si-1')
    expect(createTxJE).not.toHaveBeenCalled()

    mockServiceClient.mockReturnValue(supplierSupabase().supabase)
    const confirmed = await POST(
      makeRequest(URL, {
        items: [{ transaction_id: TX_A, categorization: { ...categorization, confirm_no_match: true } }],
      }),
      batchParams(),
    )
    expect((await confirmed.json()).data.summary).toEqual({ total: 1, succeeded: 1, failed: 0 })
    expect(createTxJE).toHaveBeenCalledTimes(1)
  })
})

describe('POST batch-categorize already-booked guard', () => {
  it('refuses a link-only item with TRANSACTION_ALREADY_CATEGORIZED and creates no verifikat', async () => {
    // A bulk-booked samlingsverifikat (N>1) anchors the row through a bank_line
    // voucher link only: journal_entry_id stays NULL.
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
          cash_account_id: null,
          journal_entry_id: null,
        },
        error: null,
      },
      transaction_voucher_links: { data: [{ journal_entry_id: 'je-samling', role: 'bank_line' }], error: null },
      journal_entries: { data: [{ id: 'je-samling', status: 'posted' }], error: null },
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/transactions/batch-categorize`, {
        items: [{ transaction_id: TX_A, categorization: { is_business: true, category: 'expense_office' } }],
      }),
      batchParams(),
    )

    const body = await res.json()
    expect(body.data.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
    expect(body.data.results[0].error).toEqual(
      expect.objectContaining({
        code: 'TRANSACTION_ALREADY_CATEGORIZED',
        details: { journal_entry_id: 'je-samling', via: 'link' },
      }),
    )
    expect(createTxJE).not.toHaveBeenCalled()
    expect(updates.transactions).toBeUndefined()
  })
})
