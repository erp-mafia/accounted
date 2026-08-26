/**
 * Tests for POST /api/v1/companies/{companyId}/transactions/{id}/categorize.
 *
 * Focus: the CAS-race compensation. When the transaction update matches no
 * row, the already-posted verifikation is orphaned. The route stornos it; if
 * the storno fails the voucher number stays stranded, and BFNAR 2013:2
 * requires that break in the verifikationsnummerserie to be documented in
 * voucher_gap_explanations. This asserts the insert payload column-for-column:
 * the table has user_id / gap_start / gap_end (all NOT NULL) and no
 * gap_number / created_by.
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
  return { ...actual, findUnresolvableAccounts: findMissingAccountsMock }
})
// Best-effort learning writes: not part of this surface.
vi.mock('@/lib/bookkeeping/counterparty-templates', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/bookkeeping/counterparty-templates')
  >('@/lib/bookkeeping/counterparty-templates')
  return { ...actual, upsertCounterpartyTemplate: vi.fn().mockResolvedValue(undefined) }
})
vi.mock('@/lib/bookkeeping/mapping-engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/mapping-engine')>(
    '@/lib/bookkeeping/mapping-engine',
  )
  return { ...actual, saveUserMappingRule: vi.fn().mockResolvedValue(undefined) }
})
// Underlag propagation: mocked to assert the WIRING (called after a booking
// this request owns, skipped otherwise); the helper's own behavior (pin
// anchoring, never-steal, failure isolation) is unit-tested in
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
  // phantom column, so the assertion has to inspect the object itself.
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
const TX_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function makeRequest(body: unknown): Request {
  return new Request(
    `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/categorize`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-fixture-not-a-real-key',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem1234-aaaa-4abc-8def-1234567890ab',
      },
      body: JSON.stringify(body),
    },
  )
}
function routeParams() {
  return { params: Promise.resolve({ companyId: COMPANY_ID, id: TX_ID }) }
}

function casRaceSupabase() {
  return makeFlexibleSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    transactions: [
      // 1: the fetch. 2: the CAS update, matching no row because a concurrent
      // request stamped journal_entry_id first.
      {
        data: {
          id: TX_ID,
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

function happyPathSupabase(transactionOverrides: Record<string, unknown> = {}) {
  return makeFlexibleSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    transactions: [
      {
        data: {
          id: TX_ID,
          company_id: COMPANY_ID,
          date: '2026-05-12',
          amount: -349.5,
          currency: 'SEK',
          merchant_name: 'ICA',
          cash_account_id: null,
          journal_entry_id: null,
          ...transactionOverrides,
        },
        error: null,
      },
      // The CAS update matches the row: this request owns the booking.
      { data: [{ id: TX_ID }], error: null },
    ],
    company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
    fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
  })
}

describe('POST /api/v1/.../transactions/{id}/categorize underlag propagation', () => {
  it('propagates underlag onto the fresh verifikat after a successful booking', async () => {
    const { supabase } = happyPathSupabase()
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest({ is_business: true, category: 'expense_office' }),
      routeParams(),
    )

    const body = await res.json()
    expect(body.data.success).toBe(true)
    expect(body.data.journal_entry_id).toBe('je-fresh')
    expect(propagateUnderlagMock).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      TX_ID,
      'je-fresh',
    )
  })

  it('does not propagate on the partial-success path (no journal entry was created)', async () => {
    const { supabase } = happyPathSupabase()
    mockServiceClient.mockReturnValue(supabase)
    createTxJE.mockRejectedValueOnce(new Error('transient engine failure'))

    const res = await POST(
      makeRequest({ is_business: true, category: 'expense_office' }),
      routeParams(),
    )

    const body = await res.json()
    expect(body.data.journal_entry_created).toBe(false)
    expect(propagateUnderlagMock).not.toHaveBeenCalled()
  })

  it('does not propagate when the CAS race is lost (the verifikat was stornoed)', async () => {
    const { supabase } = casRaceSupabase()
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest({ is_business: true, category: 'expense_office' }),
      routeParams(),
    )

    const body = await res.json()
    expect(body.error.code).toBe('TX_CATEGORIZE_RACE')
    expect(propagateUnderlagMock).not.toHaveBeenCalled()
  })

  it('returns a race conflict when the guarded update matches no row without creating an entry', async () => {
    const { supabase } = casRaceSupabase()
    mockServiceClient.mockReturnValue(supabase)
    createTxJE.mockResolvedValueOnce(null)

    const res = await POST(
      makeRequest({ is_business: true, category: 'expense_office' }),
      routeParams(),
    )

    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('TX_CATEGORIZE_RACE')
    expect(reverseEntryMock).not.toHaveBeenCalled()
  })

  it('atomically unignores an ignored transaction when categorizing it', async () => {
    const { supabase, updates } = happyPathSupabase({ is_ignored: true })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(makeRequest({ is_business: false }), routeParams())

    expect(res.status).toBe(200)
    expect(updates.transactions).toContainEqual(
      expect.objectContaining({
        is_business: false,
        category: 'private',
        is_ignored: false,
        journal_entry_id: 'je-fresh',
      }),
    )
  })

  it('maps an ignored-row constraint to a typed conflict and stornos the posted orphan', async () => {
    const { supabase } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: [
        {
          data: {
            id: TX_ID,
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

    const res = await POST(makeRequest({ is_business: false }), routeParams())
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.error.code).toBe('TX_CATEGORIZE_IGNORED_CONFLICT')
    expect(body.error.message).not.toContain('check constraint')
    expect(reverseEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      'user-1',
      'je-fresh',
    )
  })
})

describe('POST /api/v1/.../transactions/{id}/categorize CAS race', () => {
  it('documents the stranded voucher with the real voucher_gap_explanations columns when the storno fails', async () => {
    const { supabase, inserts } = casRaceSupabase()
    mockServiceClient.mockReturnValue(supabase)
    reverseEntryMock.mockRejectedValueOnce(
      withUnusedVoucherAllocation(new Error('account lookup failed'), {
        fiscalPeriodId: 'period-1',
        voucherSeries: 'B',
        voucherNumber: 43,
      }),
    )

    const res = await POST(
      makeRequest({ is_business: true, category: 'expense_office' }),
      routeParams(),
    )

    const body = await res.json()
    expect(body.error.code).toBe('TX_CATEGORIZE_RACE')

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

  it('writes no gap explanation when the storno succeeds (the series stays unbroken)', async () => {
    const { supabase, inserts } = casRaceSupabase()
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest({ is_business: true, category: 'expense_office' }),
      routeParams(),
    )

    const body = await res.json()
    expect(body.error.code).toBe('TX_CATEGORIZE_RACE')
    expect(reverseEntryMock).toHaveBeenCalledTimes(1)
    expect(inserts['voucher_gap_explanations']).toBeUndefined()
  })
})
