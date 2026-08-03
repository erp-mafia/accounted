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

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
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
          return buildChain(table)
        }
      },
    }
    return new Proxy({}, handler)
  }
  return { supabase: { from: vi.fn((table: string) => buildChain(table)) }, inserts }
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
    // Storno fails: the orphan keeps its number, so the break in the
    // verifikationsnummerserie must be documented (BFNAR 2013:2).
    reverseEntryMock.mockRejectedValueOnce(new Error('period locked'))

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
      gap_start: 42,
      gap_end: 42,
      explanation: 'CAS-race orphan; automatisk storno misslyckades. Manuell reconciliation krävs.',
    })
  })
})
