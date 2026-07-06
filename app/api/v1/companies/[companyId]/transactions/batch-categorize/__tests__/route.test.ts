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

const { createTxJE, findMissingAccountsMock } = vi.hoisted(() => ({
  createTxJE: vi.fn().mockResolvedValue({ id: 'je-fresh' }),
  // Default: every mapped account resolves (active, or seedable standard
  // BAS). Per-test overrides simulate the bug surface (inactive/unknown).
  findMissingAccountsMock: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/bookkeeping/transaction-entries', () => ({
  createTransactionJournalEntry: createTxJE,
}))
vi.mock('@/lib/bookkeeping/engine', () => ({
  reverseEntry: vi.fn().mockResolvedValue(undefined),
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
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
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
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['transactions:write'],
    mode: 'live',
  })
})

describe('POST batch-categorize', () => {
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
      }),
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
      }),
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
})
