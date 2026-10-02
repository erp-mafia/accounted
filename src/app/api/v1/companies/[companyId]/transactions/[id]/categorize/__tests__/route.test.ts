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
// Booking-time duplicate guard: the DB-backed detector is stubbed ("no
// duplicate" by default) so these tests exercise the route's wiring, not the
// detection queries, which are unit-tested in
// lib/transactions/__tests__/booking-duplicate-detection.test.ts. The real
// module is spread so its pure helpers keep their behaviour.
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
import { BookkeepingDatabaseError, withUnusedVoucherAllocation } from '@/lib/bookkeeping/errors'
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
  detectDupMock.mockReset().mockResolvedValue(null)
  appendHistoryMock.mockReset().mockResolvedValue('evt-1')
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

  it('refuses the booking and writes nothing when the journal entry cannot be created (issue #1947)', async () => {
    const { supabase, updates } = happyPathSupabase()
    mockServiceClient.mockReturnValue(supabase)
    createTxJE.mockRejectedValueOnce(
      new BookkeepingDatabaseError('commit_entry', 'Cannot write to locked/closed fiscal period "2026"'),
    )

    const res = await POST(
      makeRequest({ is_business: true, category: 'expense_office' }),
      routeParams(),
    )

    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('TX_CATEGORIZE_JOURNAL_ENTRY_FAILED')
    expect(body.error.details.cause).toBe('BOOKKEEPING_DATABASE_ERROR')
    expect(body.error.details.message).toBe(
      'Perioden är låst. Verifikationen kan inte skapas i en stängd eller låst period.',
    )
    // The row is untouched: is_business/category stay NULL so it remains in
    // the unbooked queue instead of vanishing as categorized-but-unbooked.
    expect(updates.transactions).toBeUndefined()
    expect(propagateUnderlagMock).not.toHaveBeenCalled()
    expect(reverseEntryMock).not.toHaveBeenCalled()
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

  it('returns NO_OPEN_PERIOD_FOR_DATE and writes nothing when the engine finds no covering period', async () => {
    const { supabase, updates } = happyPathSupabase()
    mockServiceClient.mockReturnValue(supabase)
    createTxJE.mockResolvedValueOnce(null)

    const res = await POST(
      makeRequest({ is_business: true, category: 'expense_office' }),
      routeParams(),
    )

    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('NO_OPEN_PERIOD_FOR_DATE')
    // Refused before the CAS write: no update, no orphan, so no storno.
    expect(updates.transactions).toBeUndefined()
    expect(reverseEntryMock).not.toHaveBeenCalled()
    expect(propagateUnderlagMock).not.toHaveBeenCalled()
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

describe('POST /api/v1/.../transactions/{id}/categorize orphaned counter-account guard (#1643)', () => {
  it('returns TX_CATEGORIZE_ORPHANED_COUNTER_ACCOUNT for an account_override on a revoked-held twin of the live row', async () => {
    const { supabase } = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: {
        data: {
          id: TX_ID,
          company_id: COMPANY_ID,
          date: '2026-05-12',
          amount: 217.04,
          currency: 'SEK',
          merchant_name: 'SEB',
          cash_account_id: 'ca-live',
          journal_entry_id: null,
        },
        error: null,
      },
      company_settings: { data: { entity_type: 'aktiebolag' }, error: null },
      chart_of_accounts: {
        data: { account_number: '1931', account_class: 1, is_active: true },
        error: null,
      },
      cash_accounts: [
        // 1: resolveSettlementAccount reads the row's own ledger (1930).
        { data: { ledger_account: '1930', currency: 'SEK' }, error: null },
        // 2: the guard's topology scan: 1931 is held by a revoked connection
        // and shares the live row's (IBAN, currency): a stale twin.
        {
          data: [
            { id: 'ca-live', ledger_account: '1930', bank_connection_id: 'conn-live', iban: 'SE111', enabled: true, currency: 'SEK' },
            { id: 'ca-orphan', ledger_account: '1931', bank_connection_id: 'conn-old', iban: 'SE111', enabled: true, currency: 'SEK' },
          ],
          error: null,
        },
      ],
      bank_connections: {
        data: [
          { id: 'conn-live', status: 'active' },
          { id: 'conn-old', status: 'revoked' },
        ],
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest({ is_business: true, category: 'income_services', account_override: '1931' }),
      routeParams(),
    )

    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error.code).toBe('TX_CATEGORIZE_ORPHANED_COUNTER_ACCOUNT')
    expect(body.error.details.accountNumber).toBe('1931')
    expect(createTxJE).not.toHaveBeenCalled()
  })
})

describe('POST /api/v1/.../transactions/{id}/categorize private marking in a locked period (issue #1661)', () => {
  function lockedPeriodSupabase() {
    return makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: {
        data: {
          id: TX_ID,
          company_id: COMPANY_ID,
          date: '2025-11-12',
          amount: -349.5,
          currency: 'SEK',
          merchant_name: 'SWISH DUBBLETT',
          cash_account_id: null,
          journal_entry_id: null,
        },
        error: null,
      },
      company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      fiscal_periods: { data: { id: 'period-2025', is_closed: false, locked_at: '2026-01-31T00:00:00Z' }, error: null },
    })
  }

  it('answers is_business: false with TX_CATEGORIZE_PRIVATE_PERIOD_LOCKED and suggested_action ignore', async () => {
    const { supabase, updates } = lockedPeriodSupabase()
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(makeRequest({ is_business: false }), routeParams())
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('TX_CATEGORIZE_PRIVATE_PERIOD_LOCKED')
    expect(body.error.details).toMatchObject({
      transaction_date: '2025-11-12',
      reason: 'period_locked_at_set',
      fiscal_period_id: 'period-2025',
      suggested_action: 'ignore',
    })
    expect(createTxJE).not.toHaveBeenCalled()
    expect(updates.transactions).toBeUndefined()
  })

  it('keeps PERIOD_LOCKED (no suggested_action) for a business categorization', async () => {
    const { supabase, updates } = lockedPeriodSupabase()
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest({ is_business: true, category: 'expense_office' }),
      routeParams(),
    )
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error.code).toBe('PERIOD_LOCKED')
    expect(body.error.details.suggested_action).toBeUndefined()
    expect(createTxJE).not.toHaveBeenCalled()
    expect(updates.transactions).toBeUndefined()
  })
})

describe('VAT registration (lib/bookkeeping/vat-registration.ts)', () => {
  // The v1 route reaches the same category-mapping seam as the dashboard:
  // the real builder runs here, so the posted mapping is what is asserted.
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
              id: TX_ID,
              company_id: COMPANY_ID,
              date: '2026-05-12',
              amount: -1250,
              currency: 'SEK',
              merchant_name: 'Adobe',
              cash_account_id: null,
              journal_entry_id: null,
            },
            error: null,
          },
          { data: [{ id: TX_ID }], error: null },
        ],
        company_settings: { data: { entity_type: 'ideell_forening', vat_registered }, error: null },
        fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
      })
      mockServiceClient.mockReturnValue(supabase)

      const res = await POST(
        makeRequest({ is_business: true, category: 'expense_software' }),
        routeParams(),
      )

      expect(res.status).toBe(200)
      expect(createTxJE).toHaveBeenCalledTimes(1)
      const mapping = createTxJE.mock.calls[0][4] as { debit_account: string; vat_lines: unknown[] }
      expect(mapping.debit_account).toBe('5420')
      expect(mapping.vat_lines).toHaveLength(vatLineCount)
    },
  )
})

describe('reverse-charge basis pair (#2919)', () => {
  // The real category builder runs: a reverse-charge purchase posts the
  // 45xx/4598 basis pair next to the fiktiv moms, and an account_override onto
  // an account that reports ruta 20-24 itself drops that pair again.
  function rcSupabase(chartRow?: Record<string, unknown>) {
    return makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: [
        {
          data: {
            id: TX_ID,
            company_id: COMPANY_ID,
            date: '2026-09-10',
            amount: -250,
            currency: 'SEK',
            merchant_name: 'Google Play',
            cash_account_id: null,
            journal_entry_id: null,
          },
          error: null,
        },
        { data: [{ id: TX_ID }], error: null },
      ],
      company_settings: { data: { entity_type: 'aktiebolag' }, error: null },
      fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
      ...(chartRow ? { chart_of_accounts: { data: chartRow, error: null } } : {}),
    })
  }

  it.each([
    { account_override: undefined, chartRow: undefined, expected: ['2645', '2614', '4535', '4598'] },
    {
      account_override: '4531',
      chartRow: { account_number: '4531', account_class: 4, is_active: true, default_vat_treatment: null },
      expected: ['2645', '2614'],
    },
    {
      account_override: '6541',
      chartRow: { account_number: '6541', account_class: 6, is_active: true, default_vat_treatment: 'reverse_charge_eu_services' },
      expected: ['2645', '2614'],
    },
  ])('posts $expected with account_override $account_override', async ({ account_override, chartRow, expected }) => {
    const { supabase } = rcSupabase(chartRow)
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest({
        is_business: true,
        category: 'expense_software',
        vat_treatment: 'reverse_charge',
        ...(account_override ? { account_override } : {}),
      }),
      routeParams(),
    )

    expect(res.status).toBe(200)
    const mapping = createTxJE.mock.calls[0][4] as { vat_lines: Array<{ account_number: string }> }
    expect(mapping.vat_lines.map((l) => l.account_number)).toEqual(expected)
  })
})

// Learned dimension bags (D5): the template picked by counterparty_template_id
// is loaded through the same pruning loader as the dashboard door, so a
// learned code whose value was archived since is dropped instead of turning
// the booking into a DimensionValidationError. An explicit pick is not.
describe('counterparty template with a learned bag', () => {
  const TEMPLATE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  function templateSupabase(template: Record<string, unknown> | null) {
    return makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: [
        {
          data: {
            id: TX_ID,
            company_id: COMPANY_ID,
            date: '2026-05-12',
            amount: -1250,
            currency: 'SEK',
            merchant_name: 'Telia',
            cash_account_id: null,
            journal_entry_id: null,
          },
          error: null,
        },
        { data: [{ id: TX_ID }], error: null },
      ],
      // One row serves the entity read and the registry toggle read.
      company_settings: { data: { entity_type: 'aktiebolag', dimensions_enabled: true }, error: null },
      categorization_templates: { data: template, error: null },
      dimensions: { data: [{ id: 'dim-1', sie_dim_no: 1 }, { id: 'dim-6', sie_dim_no: 6 }], error: null },
      dimension_values: {
        data: [
          { dimension_id: 'dim-1', code: 'KS01', is_active: true },
          { dimension_id: 'dim-6', code: 'P001', is_active: false },
        ],
        error: null,
      },
      fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
    })
  }
  const template = {
    id: TEMPLATE_ID,
    company_id: COMPANY_ID,
    counterparty_name: 'telia',
    counterparty_aliases: [],
    debit_account: '6200',
    credit_account: '1930',
    vat_treatment: null,
    vat_account: null,
    category: null,
    line_pattern: null,
    occurrence_count: 3,
    confidence: 0.9,
    source: 'user_approved',
    is_active: true,
    default_dimensions: { '1': 'KS01', '6': 'P001' },
  }

  it('books the learned bag without the archived code', async () => {
    mockServiceClient.mockReturnValue(templateSupabase(template).supabase)

    const res = await POST(makeRequest({ is_business: true, counterparty_template_id: TEMPLATE_ID }), routeParams())

    expect(res.status).toBe(200)
    const mapping = createTxJE.mock.calls[0][4] as { dimensions?: Record<string, string> }
    expect(mapping.dimensions).toEqual({ '1': 'KS01' })
  })

  it('passes an explicit pick through unfiltered', async () => {
    mockServiceClient.mockReturnValue(templateSupabase(template).supabase)

    const res = await POST(
      makeRequest({ is_business: true, counterparty_template_id: TEMPLATE_ID, dimensions: { '6': 'P001' } }),
      routeParams(),
    )

    expect(res.status).toBe(200)
    const mapping = createTxJE.mock.calls[0][4] as { dimensions?: Record<string, string> }
    expect(mapping.dimensions).toEqual({ '6': 'P001' })
  })

  it('404 NOT_FOUND for a template that is not an active one of the company', async () => {
    mockServiceClient.mockReturnValue(templateSupabase(null).supabase)

    const res = await POST(makeRequest({ is_business: true, counterparty_template_id: TEMPLATE_ID }), routeParams())

    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('NOT_FOUND')
    expect(createTxJE).not.toHaveBeenCalled()
  })
})

describe('POST /api/v1/.../transactions/{id}/categorize duplicate-payment guard (parity with the dashboard route)', () => {
  const EXISTING_JE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const OTHER_JE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  // A ledger-only voucher that already books the same amount on the bank
  // account: e.g. a supplier invoice marked paid ("Markera som betald").
  const candidate = {
    transaction_id: null,
    journal_entry_id: EXISTING_JE,
    voucher_label: 'A12',
    entry_date: '2026-05-12',
    description: 'Leverantörsfaktura 100 betald',
    amount: -349.5,
    account_number: '1930',
    currency: null,
    amount_in_currency: null,
    amount_verified: true,
    unverified_reason: null,
  }

  it('returns 401 without a valid bearer token', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(happyPathSupabase().supabase)

    const res = await POST(makeRequest({ is_business: true, category: 'expense_office' }), routeParams())

    expect(res.status).toBe(401)
    expect(detectDupMock).not.toHaveBeenCalled()
    expect(createTxJE).not.toHaveBeenCalled()
  })

  it('returns 400 for force=true without the reviewed candidate id', async () => {
    mockServiceClient.mockReturnValue(happyPathSupabase().supabase)

    const res = await POST(
      makeRequest({ is_business: true, category: 'expense_office', force: true }),
      routeParams(),
    )

    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    expect(createTxJE).not.toHaveBeenCalled()
  })

  it('refuses with 409 TRANSACTION_BOOK_POSSIBLE_DUPLICATE and writes nothing when the bank line is already booked', async () => {
    const { supabase, updates } = happyPathSupabase()
    mockServiceClient.mockReturnValue(supabase)
    detectDupMock.mockResolvedValue(candidate)

    const res = await POST(makeRequest({ is_business: true, category: 'expense_office' }), routeParams())

    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('TRANSACTION_BOOK_POSSIBLE_DUPLICATE')
    expect(body.error.details.candidate.journal_entry_id).toBe(EXISTING_JE)
    expect(detectDupMock).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      expect.objectContaining({ id: TX_ID, date: '2026-05-12', amount: -349.5, currency: 'SEK' }),
      undefined,
    )
    expect(createTxJE).not.toHaveBeenCalled()
    expect(updates.transactions).toBeUndefined()
    expect(appendHistoryMock).not.toHaveBeenCalled()
  })

  it('books over the candidate with force=true bound to it and records the dismissal in behandlingshistorik', async () => {
    mockServiceClient.mockReturnValue(happyPathSupabase().supabase)
    detectDupMock.mockResolvedValue(candidate)

    const res = await POST(
      makeRequest({
        is_business: true,
        category: 'expense_office',
        force: true,
        expected_duplicate_journal_entry_id: EXISTING_JE,
      }),
      routeParams(),
    )

    expect(res.status).toBe(200)
    expect((await res.json()).data.journal_entry_id).toBe('je-fresh')
    expect(createTxJE).toHaveBeenCalledTimes(1)
    expect(appendHistoryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: COMPANY_ID,
        aggregateId: TX_ID,
        eventType: 'BankTransactionDuplicateDismissed',
        payload: expect.objectContaining({
          transaction_id: TX_ID,
          dismissed_journal_entry_id: EXISTING_JE,
          amount_ore: -34950,
          via: 'api_force',
        }),
        actor: { type: 'user', id: 'user-1' },
      }),
    )
  })

  it('refuses a force=true bound to a candidate that no longer matches with TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH', async () => {
    mockServiceClient.mockReturnValue(happyPathSupabase().supabase)
    detectDupMock.mockResolvedValue({ ...candidate, journal_entry_id: OTHER_JE })

    const res = await POST(
      makeRequest({
        is_business: true,
        category: 'expense_office',
        force: true,
        expected_duplicate_journal_entry_id: EXISTING_JE,
      }),
      routeParams(),
    )

    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('TRANSACTION_BOOK_FORCE_CANDIDATE_MISMATCH')
    expect(body.error.details.detected_journal_entry_id).toBe(OTHER_JE)
    expect(createTxJE).not.toHaveBeenCalled()
    expect(appendHistoryMock).not.toHaveBeenCalled()
  })

  it('fails open when duplicate detection itself errors (no force): the booking proceeds', async () => {
    mockServiceClient.mockReturnValue(happyPathSupabase().supabase)
    detectDupMock.mockRejectedValue(new Error('statement timeout'))

    const res = await POST(makeRequest({ is_business: true, category: 'expense_office' }), routeParams())

    expect(res.status).toBe(200)
    expect(createTxJE).toHaveBeenCalledTimes(1)
  })

  it('surfaces the duplicate refusal on a dry-run, and a bound force previews without writing the dismissal', async () => {
    mockServiceClient.mockReturnValue(happyPathSupabase().supabase)
    detectDupMock.mockResolvedValue(candidate)

    const dryUrl = `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/categorize?dry_run=true`
    const dryRequest = (body: unknown) => {
      const base = makeRequest(body)
      return new Request(dryUrl, { method: 'POST', headers: base.headers, body: JSON.stringify(body) })
    }

    const refused = await POST(dryRequest({ is_business: true, category: 'expense_office' }), routeParams())
    expect(refused.status).toBe(409)
    expect((await refused.json()).error.code).toBe('TRANSACTION_BOOK_POSSIBLE_DUPLICATE')

    const forced = await POST(
      dryRequest({
        is_business: true,
        category: 'expense_office',
        force: true,
        expected_duplicate_journal_entry_id: EXISTING_JE,
      }),
      routeParams(),
    )
    expect(forced.status).toBe(200)
    expect(createTxJE).not.toHaveBeenCalled()
    expect(appendHistoryMock).not.toHaveBeenCalled()
  })

  it('does not run the guard on the already-categorized fast path (the verifikat already exists)', async () => {
    mockServiceClient.mockReturnValue(happyPathSupabase({ journal_entry_id: EXISTING_JE }).supabase)
    detectDupMock.mockResolvedValue(candidate)

    const res = await POST(makeRequest({ is_business: true, category: 'expense_office' }), routeParams())

    expect(res.status).toBe(200)
    expect((await res.json()).data.already_had_journal_entry).toBe(true)
    expect(detectDupMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/v1/.../transactions/{id}/categorize invoice-match intercept (parity with the dashboard route)', () => {
  // A supplier payment categorized straight onto leverantörsskulder (244x)
  // while an open supplier invoice from the same supplier covers the amount.
  function supplierPaymentSupabase() {
    return makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: [
        {
          data: {
            id: TX_ID,
            company_id: COMPANY_ID,
            date: '2026-05-12',
            amount: -1250,
            currency: 'SEK',
            merchant_name: 'Kontorsbolaget',
            cash_account_id: null,
            journal_entry_id: null,
          },
          error: null,
        },
        { data: [{ id: TX_ID }], error: null },
      ],
      company_settings: { data: { entity_type: 'aktiebolag' }, error: null },
      chart_of_accounts: {
        data: { account_number: '2440', account_class: 2, default_vat_treatment: null },
        error: null,
      },
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
  }

  // An inbound payment categorized straight onto kundfordringar (151x) while
  // an unpaid customer invoice covers the amount.
  function customerReceiptSupabase() {
    return makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      transactions: [
        {
          data: {
            id: TX_ID,
            company_id: COMPANY_ID,
            date: '2026-05-12',
            amount: 5000,
            currency: 'SEK',
            merchant_name: 'Kund AB',
            description: 'Kund AB',
            cash_account_id: null,
            journal_entry_id: null,
          },
          error: null,
        },
        { data: [{ id: TX_ID }], error: null },
      ],
      company_settings: { data: { entity_type: 'aktiebolag' }, error: null },
      chart_of_accounts: {
        data: { account_number: '1510', account_class: 1, default_vat_treatment: null },
        error: null,
      },
      customers: { data: [{ id: 'cust-1' }], error: null },
      invoices: {
        data: [
          {
            id: 'inv-1',
            invoice_number: '1001',
            invoice_date: '2026-04-12',
            due_date: '2026-05-12',
            remaining_amount: 5000,
            total: 5000,
            currency: 'SEK',
            total_sek: 5000,
            exchange_rate: null,
            customer: { name: 'Kund AB' },
          },
        ],
        error: null,
      },
      fiscal_periods: { data: { id: 'period-1', is_closed: false, locked_at: null }, error: null },
    })
  }

  it('intercepts a plain 244x categorization with TX_CATEGORIZE_SUGGEST_SI_MATCH and writes nothing', async () => {
    const { supabase, updates } = supplierPaymentSupabase()
    mockServiceClient.mockReturnValue(supabase)

    const res = await POST(
      makeRequest({ is_business: true, category: 'expense_other', account_override: '2440' }),
      routeParams(),
    )

    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('TX_CATEGORIZE_SUGGEST_SI_MATCH')
    expect(body.error.details.candidates).toEqual([
      expect.objectContaining({
        supplier_invoice_id: 'si-1',
        invoice_number: 'F-100',
        remaining_amount: 1250,
        supplier_name: 'Kontorsbolaget AB',
      }),
    ])
    expect(createTxJE).not.toHaveBeenCalled()
    expect(updates.transactions).toBeUndefined()
  })

  it('books the plain 244x categorization when confirm_no_match: true overrides the intercept', async () => {
    mockServiceClient.mockReturnValue(supplierPaymentSupabase().supabase)

    const res = await POST(
      makeRequest({
        is_business: true,
        category: 'expense_other',
        account_override: '2440',
        confirm_no_match: true,
      }),
      routeParams(),
    )

    expect(res.status).toBe(200)
    expect(createTxJE).toHaveBeenCalledTimes(1)
    const mapping = createTxJE.mock.calls[0][4] as { debit_account: string; credit_account: string }
    expect(mapping.debit_account).toBe('2440')
    expect(mapping.credit_account).toBe('1930')
  })

  it('surfaces the intercept on a dry-run too', async () => {
    mockServiceClient.mockReturnValue(supplierPaymentSupabase().supabase)
    const body = { is_business: true, category: 'expense_other', account_override: '2440' }
    const base = makeRequest(body)
    const res = await POST(
      new Request(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/categorize?dry_run=true`,
        { method: 'POST', headers: base.headers, body: JSON.stringify(body) },
      ),
      routeParams(),
    )

    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('TX_CATEGORIZE_SUGGEST_SI_MATCH')
  })

  it('intercepts a plain 151x categorization of an inbound payment with TX_CATEGORIZE_SUGGEST_CI_MATCH', async () => {
    mockServiceClient.mockReturnValue(customerReceiptSupabase().supabase)

    const res = await POST(
      makeRequest({ is_business: true, category: 'income_services', account_override: '1510' }),
      routeParams(),
    )

    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.error.code).toBe('TX_CATEGORIZE_SUGGEST_CI_MATCH')
    expect(body.error.details.candidates[0]).toEqual(
      expect.objectContaining({ invoice_id: 'inv-1', customer_name: 'Kund AB' }),
    )
    expect(createTxJE).not.toHaveBeenCalled()
  })
})
