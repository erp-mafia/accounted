/**
 * Integration tests for the single-transaction write verbs:
 *   POST :id/categorize
 *   POST :id/uncategorize
 *   POST :id/match-invoice
 *   POST :id/match-supplier-invoice
 *
 * Each test stubs the bookkeeping engine (createTransactionJournalEntry,
 * createInvoicePaymentJournalEntry, reverseEntry, etc.) so the test asserts
 * the route's orchestration (wiring of params + scope + error codes)
 * rather than reimplementing the engine.
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

// Engine stubs: happy-path returns reusable across cases.
const { createTxJE, reverseEntryMock, createInvPmtJE, createInvCashJE, createSupplierInvPmtJE, findMissingAccountsMock } = vi.hoisted(() => ({
  createTxJE: vi.fn().mockResolvedValue({ id: 'je-fresh' }),
  reverseEntryMock: vi.fn().mockResolvedValue(undefined),
  createInvPmtJE: vi.fn().mockResolvedValue({ id: 'je-invpmt' }),
  createInvCashJE: vi.fn().mockResolvedValue({ id: 'je-invcash' }),
  createSupplierInvPmtJE: vi.fn().mockResolvedValue({ id: 'je-sipmt' }),
  // Default: no missing accounts. Per-case overrides simulate the
  // template-references-inactive-account bug or a race where deactivation
  // happened between our validation and the engine's resolveAccountIds.
  findMissingAccountsMock: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/lib/bookkeeping/transaction-entries', () => ({
  createTransactionJournalEntry: createTxJE,
}))
vi.mock('@/lib/bookkeeping/engine', () => ({
  reverseEntry: reverseEntryMock,
}))
vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoicePaymentJournalEntry: createInvPmtJE,
  createInvoiceCashEntry: createInvCashJE,
}))
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
  createSupplierInvoicePaymentEntry: createSupplierInvPmtJE,
  createSupplierInvoiceCashEntry: vi.fn().mockResolvedValue({ id: 'je-sicash' }),
}))
vi.mock('@/lib/invoices/match-log', () => ({
  logMatchEvent: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/mapping-engine', async () => {
  // Keep the real applySettlementAccount: it's a pure rewrite (1930 -> the
  // resolved bank leg) and the v1 categorize route's settlement-account fix
  // depends on it actually running, not a stub.
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/mapping-engine')>(
    '@/lib/bookkeeping/mapping-engine',
  )
  return {
    ...actual,
    saveUserMappingRule: vi.fn().mockResolvedValue(undefined),
  }
})
vi.mock('@/lib/bookkeeping/counterparty-templates', () => ({
  upsertCounterpartyTemplate: vi.fn().mockResolvedValue(undefined),
  buildMappingResultFromCounterpartyTemplate: vi.fn(),
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
// category mapping is real: provides the debit/credit account guarantees.

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as categorizePOST } from '../categorize/route'
import { POST as uncategorizePOST } from '../uncategorize/route'
import { POST as matchInvoicePOST } from '../match-invoice/route'
import { POST as matchSIPOST } from '../match-supplier-invoice/route'

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
const TX_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const INV_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SI_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const JE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

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
function txParams(id: string) {
  return { params: Promise.resolve({ companyId: COMPANY_ID, id }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['transactions:write'],
    mode: 'live',
  })
})

describe('POST :id/categorize', () => {
  it('categorizes a fresh business transaction and creates the JE', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
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
              journal_entry_id: null,
            },
            error: null,
          },
          { data: [{ id: TX_ID }], error: null }, // CAS update select
        ],
        company_settings: {
          data: { entity_type: 'enskild_firma' },
          error: null,
        },
      }),
    )

    const res = await categorizePOST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/categorize`,
        { is_business: true, category: 'expense_office' },
      ),
      txParams(TX_ID),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.journal_entry_created).toBe(true)
    expect(body.data.category).toBe('expense_office')
    expect(createTxJE).toHaveBeenCalledTimes(1)
  })

  it('dry-run returns mapping preview without creating a JE', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: {
          data: {
            id: TX_ID,
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
      }),
    )

    const res = await categorizePOST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/categorize?dry_run=true`,
        { is_business: true, category: 'expense_office' },
      ),
      txParams(TX_ID),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    expect(createTxJE).not.toHaveBeenCalled()
  })

  it('rejects unknown transaction id with TX_CATEGORIZE_TX_NOT_FOUND', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: { data: null, error: { code: 'PGRST116' } },
      }),
    )
    const res = await categorizePOST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/categorize`,
        { is_business: true, category: 'expense_office' },
      ),
      txParams(TX_ID),
    )
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('TX_CATEGORIZE_TX_NOT_FOUND')
  })

  it('returns 400 ACCOUNTS_NOT_IN_CHART when mapped accounts are not active in the kontoplan', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: {
          data: {
            id: TX_ID,
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
      }),
    )
    // Simulate the user-reported bug: a category/template that maps to an
    // account they haven't activated in their kontoplan.
    findMissingAccountsMock.mockResolvedValueOnce(['5410'])

    const res = await categorizePOST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/categorize`,
        { is_business: true, category: 'expense_office' },
      ),
      txParams(TX_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('ACCOUNTS_NOT_IN_CHART')
    // The v1 envelope routes typed bookkeeping errors through
    // extractBookkeepingDetails, which places account_numbers under details.
    expect(body.error.details.account_numbers).toEqual(['5410'])
    // Engine and transaction-update must NOT run: the row stays in the
    // categorization queue so the user can re-activate and retry.
    expect(createTxJE).not.toHaveBeenCalled()
  })

  it('returns 400 ACCOUNTS_NOT_IN_CHART when the engine throws mid-flight (defense in depth)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: {
          data: {
            id: TX_ID,
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
    // Pre-validation passes: race condition where an account got
    // deactivated between our chart_of_accounts read and the engine's
    // resolveAccountIds read. The engine throws and the catch in the route
    // must short-circuit to a structured 400 rather than falling through
    // to the partial-success branch that would mark the row bokförd with
    // no verifikation.
    findMissingAccountsMock.mockResolvedValueOnce([])
    const { AccountsNotInChartError } = await import('@/lib/bookkeeping/errors')
    createTxJE.mockRejectedValueOnce(new AccountsNotInChartError(['5410']))

    const res = await categorizePOST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/categorize`,
        { is_business: true, category: 'expense_office' },
      ),
      txParams(TX_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('ACCOUNTS_NOT_IN_CHART')
    expect(body.error.details.account_numbers).toEqual(['5410'])
  })

  // Regression for the v1/MCP-facing half of the settlement-account gap
  // fixed on the dashboard route by PR #985: this v1 route never called
  // applySettlementAccount at all, so every category booking hardcoded the
  // bank leg to 1930 even when the transaction was linked to a different
  // cash account (e.g. a savings or EUR account).
  it('books the bank leg to the transaction\'s linked cash account, not hardcoded 1930', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
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
              journal_entry_id: null,
              cash_account_id: 'ca-1940',
            },
            error: null,
          },
          { data: [{ id: TX_ID }], error: null }, // CAS update select
        ],
        company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
        cash_accounts: { data: { ledger_account: '1940' }, error: null },
      }),
    )

    const res = await categorizePOST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/categorize`,
        { is_business: true, category: 'expense_office' },
      ),
      txParams(TX_ID),
    )
    expect(res.status).toBe(200)
    expect(createTxJE).toHaveBeenCalledTimes(1)
    const mappingResult = createTxJE.mock.calls[0][4] as {
      debit_account: string
      credit_account: string
    }
    expect(mappingResult.credit_account).toBe('1940')
  })

  it('falls back to 1930 when the transaction has no linked cash account', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
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
              journal_entry_id: null,
              cash_account_id: null,
            },
            error: null,
          },
          { data: [{ id: TX_ID }], error: null },
        ],
        company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
      }),
    )

    const res = await categorizePOST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/categorize`,
        { is_business: true, category: 'expense_office' },
      ),
      txParams(TX_ID),
    )
    expect(res.status).toBe(200)
    const mappingResult = createTxJE.mock.calls[0][4] as { credit_account: string }
    expect(mappingResult.credit_account).toBe('1930')
  })

  it('aborts with 500 BOOKKEEPING_DATABASE_ERROR when the cash_accounts lookup errors, mutating nothing', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: {
          data: {
            id: TX_ID,
            company_id: COMPANY_ID,
            date: '2026-05-12',
            amount: -349.5,
            currency: 'SEK',
            merchant_name: 'ICA',
            journal_entry_id: null,
            cash_account_id: 'ca-broken',
          },
          error: null,
        },
        company_settings: { data: { entity_type: 'enskild_firma' }, error: null },
        cash_accounts: { data: null, error: { message: 'connection reset' } },
      }),
    )

    const res = await categorizePOST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/categorize`,
        { is_business: true, category: 'expense_office' },
      ),
      txParams(TX_ID),
    )
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('BOOKKEEPING_DATABASE_ERROR')
    expect(createTxJE).not.toHaveBeenCalled()
  })
})

describe('POST :id/uncategorize', () => {
  it('storno + reset on a booked transaction', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: { data: { id: TX_ID, journal_entry_id: JE_ID }, error: null },
        journal_entries: { data: { id: JE_ID, status: 'posted' }, error: null },
      }),
    )
    const res = await uncategorizePOST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/uncategorize`,
        {},
      ),
      txParams(TX_ID),
    )
    expect(res.status).toBe(200)
    expect(reverseEntryMock).toHaveBeenCalledTimes(1)
  })

  it('returns TX_UNCATEGORIZE_NOT_BOOKED when JE missing', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: { data: { id: TX_ID, journal_entry_id: null }, error: null },
      }),
    )
    const res = await uncategorizePOST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/uncategorize`,
        {},
      ),
      txParams(TX_ID),
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('TX_UNCATEGORIZE_NOT_BOOKED')
  })
})

describe('POST :id/match-invoice', () => {
  it('matches a positive transaction to an open invoice', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: {
          data: {
            id: TX_ID,
            amount: 12500,
            date: '2026-05-12',
            currency: 'SEK',
            invoice_id: null,
            journal_entry_id: null,
          },
          error: null,
        },
        invoices: [
          {
            data: {
              id: INV_ID,
              status: 'sent',
              document_type: 'invoice',
              total: 12500,
              paid_amount: 0,
              remaining_amount: 12500,
              currency: 'SEK',
              exchange_rate: null,
              customer: { name: 'Acme' },
              items: [],
              journal_entry_id: null,
            },
            error: null,
          },
          { data: [{ id: INV_ID }], error: null }, // status update select
        ],
        company_settings: { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null },
        invoice_payments: { data: null, error: null },
      }),
    )
    const res = await matchInvoicePOST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-invoice`,
        { invoice_id: INV_ID },
      ),
      txParams(TX_ID),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.invoice_status).toBe('paid')
    expect(body.data.journal_entry_id).toBe('je-invpmt')
  })

  it('rejects negative transaction with MATCH_INVOICE_NOT_INCOME', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: { data: { id: TX_ID, amount: -100, invoice_id: null }, error: null },
      }),
    )
    const res = await matchInvoicePOST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-invoice`,
        { invoice_id: INV_ID },
      ),
      txParams(TX_ID),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('MATCH_INVOICE_NOT_INCOME')
  })

  it('rejects already-linked transaction', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: { data: { id: TX_ID, amount: 100, invoice_id: 'other-id' }, error: null },
      }),
    )
    const res = await matchInvoicePOST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-invoice`,
        { invoice_id: INV_ID },
      ),
      txParams(TX_ID),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('MATCH_INVOICE_TX_ALREADY_LINKED')
  })

  // The v1 route threads resolveSettlementAccount(transaction.cash_account_id)
  // exactly like the dashboard route and the agent/MCP commit path; these
  // regression tests were missing here (flagged in triage on #987) even
  // though the lib-level resolveSettlementAccount tests and the dashboard
  // route tests already cover the same behavior.
  describe('settlement account resolution', () => {
    it('credits the transaction\'s own linked cash account, not 1930', async () => {
      mockServiceClient.mockReturnValue(
        makeFlexibleSupabase({
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          transactions: {
            data: {
              id: TX_ID,
              amount: 12500,
              date: '2026-05-12',
              currency: 'SEK',
              invoice_id: null,
              journal_entry_id: null,
              cash_account_id: 'ca-1940',
            },
            error: null,
          },
          invoices: [
            {
              data: {
                id: INV_ID,
                status: 'sent',
                document_type: 'invoice',
                total: 12500,
                paid_amount: 0,
                remaining_amount: 12500,
                currency: 'SEK',
                exchange_rate: null,
                customer: { name: 'Acme' },
                items: [],
                journal_entry_id: null,
              },
              error: null,
            },
            { data: [{ id: INV_ID }], error: null },
          ],
          company_settings: { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null },
          cash_accounts: { data: { ledger_account: '1940' }, error: null },
          invoice_payments: { data: null, error: null },
        }),
      )
      const res = await matchInvoicePOST(
        makeRequest(
          `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-invoice`,
          { invoice_id: INV_ID },
        ),
        txParams(TX_ID),
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.data.invoice_status).toBe('paid')
      expect(createInvPmtJE).toHaveBeenCalledWith(
        expect.anything(),
        COMPANY_ID,
        'user-1',
        expect.objectContaining({ id: INV_ID }),
        '2026-05-12',
        undefined,
        'Acme',
        12500,
        '1940',
      )
    })

    it('aborts with 500 BOOKKEEPING_DATABASE_ERROR (mutates nothing) when the cash_accounts lookup errors', async () => {
      mockServiceClient.mockReturnValue(
        makeFlexibleSupabase({
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          transactions: {
            data: {
              id: TX_ID,
              amount: 12500,
              date: '2026-05-12',
              currency: 'SEK',
              invoice_id: null,
              journal_entry_id: null,
              cash_account_id: 'ca-1940',
            },
            error: null,
          },
          invoices: {
            data: {
              id: INV_ID,
              status: 'sent',
              document_type: 'invoice',
              total: 12500,
              paid_amount: 0,
              remaining_amount: 12500,
              currency: 'SEK',
              exchange_rate: null,
              customer: { name: 'Acme' },
              items: [],
              journal_entry_id: null,
            },
            error: null,
          },
          company_settings: { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null },
          cash_accounts: { data: null, error: { message: 'boom' } },
        }),
      )
      const res = await matchInvoicePOST(
        makeRequest(
          `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-invoice`,
          { invoice_id: INV_ID },
        ),
        txParams(TX_ID),
      )
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.error.code).toBe('BOOKKEEPING_DATABASE_ERROR')
      expect(createInvPmtJE).not.toHaveBeenCalled()
      expect(createInvCashJE).not.toHaveBeenCalled()
    })

    it('returns 400 ACCOUNTS_NOT_IN_CHART when the linked cash account is deactivated in the kontoplan', async () => {
      mockServiceClient.mockReturnValue(
        makeFlexibleSupabase({
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          transactions: {
            data: {
              id: TX_ID,
              amount: 12500,
              date: '2026-05-12',
              currency: 'SEK',
              invoice_id: null,
              journal_entry_id: null,
              cash_account_id: 'ca-1940',
            },
            error: null,
          },
          invoices: {
            data: {
              id: INV_ID,
              status: 'sent',
              document_type: 'invoice',
              total: 12500,
              paid_amount: 0,
              remaining_amount: 12500,
              currency: 'SEK',
              exchange_rate: null,
              customer: { name: 'Acme' },
              items: [],
              journal_entry_id: null,
            },
            error: null,
          },
          company_settings: { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null },
          cash_accounts: { data: { ledger_account: '1940' }, error: null },
        }),
      )
      // Simulate the 1940 account existing in cash_accounts but having been
      // deactivated in chart_of_accounts since.
      findMissingAccountsMock.mockResolvedValueOnce(['1940'])

      const res = await matchInvoicePOST(
        makeRequest(
          `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-invoice`,
          { invoice_id: INV_ID },
        ),
        txParams(TX_ID),
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error.code).toBe('ACCOUNTS_NOT_IN_CHART')
      expect(body.error.details.account_numbers).toEqual(['1940'])
      // Engine and invoice/transaction updates must NOT run: the match stays
      // retryable rather than posting a payment against a dead account.
      expect(createInvPmtJE).not.toHaveBeenCalled()
      expect(createInvCashJE).not.toHaveBeenCalled()
    })
  })
})

describe('POST :id/match-supplier-invoice', () => {
  it('matches a negative transaction to an open supplier invoice', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: {
          data: {
            id: TX_ID,
            amount: -5000,
            date: '2026-05-12',
            currency: 'SEK',
            supplier_invoice_id: null,
            journal_entry_id: null,
          },
          error: null,
        },
        supplier_invoices: [
          {
            data: {
              id: SI_ID,
              status: 'approved',
              total: 5000,
              paid_amount: 0,
              remaining_amount: 5000,
              currency: 'SEK',
              exchange_rate: null,
              supplier: { name: 'Acme', supplier_type: 'swedish_business' },
              items: [],
            },
            error: null,
          },
          { data: [{ id: SI_ID }], error: null },
        ],
        company_settings: { data: { accounting_method: 'accrual' }, error: null },
        supplier_invoice_payments: { data: null, error: null },
      }),
    )
    const res = await matchSIPOST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-supplier-invoice`,
        { supplier_invoice_id: SI_ID },
      ),
      txParams(TX_ID),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.invoice_status).toBe('paid')
  })

  it('rejects positive transaction with MATCH_SI_NOT_EXPENSE', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        transactions: { data: { id: TX_ID, amount: 100, supplier_invoice_id: null }, error: null },
      }),
    )
    const res = await matchSIPOST(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-supplier-invoice`,
        { supplier_invoice_id: SI_ID },
      ),
      txParams(TX_ID),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('MATCH_SI_NOT_EXPENSE')
  })

  // Regression for the v1/MCP-facing half of the settlement-account gap
  // fixed on the dashboard route by PR #985: this route always called
  // createSupplierInvoicePaymentEntry with no paymentAccount argument at all
  // (hardcoded internal default 1930) for every pure-SEK accrual match,
  // regardless of which cash account the transaction was actually linked to.
  describe('settlement account resolution (pure-SEK accrual path)', () => {
    it('credits the transaction\'s own linked cash account when it is not the primary 1930', async () => {
      mockServiceClient.mockReturnValue(
        makeFlexibleSupabase({
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          transactions: {
            data: {
              id: TX_ID,
              amount: -5000,
              date: '2026-05-12',
              currency: 'SEK',
              supplier_invoice_id: null,
              journal_entry_id: null,
              cash_account_id: 'ca-1940',
            },
            error: null,
          },
          supplier_invoices: [
            {
              data: {
                id: SI_ID,
                status: 'approved',
                total: 5000,
                paid_amount: 0,
                remaining_amount: 5000,
                currency: 'SEK',
                exchange_rate: null,
                supplier: { name: 'Acme', supplier_type: 'swedish_business' },
                items: [],
              },
              error: null,
            },
            { data: [{ id: SI_ID }], error: null },
          ],
          company_settings: { data: { accounting_method: 'accrual' }, error: null },
          cash_accounts: { data: { ledger_account: '1940' }, error: null },
          supplier_invoice_payments: { data: null, error: null },
        }),
      )
      const res = await matchSIPOST(
        makeRequest(
          `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-supplier-invoice`,
          { supplier_invoice_id: SI_ID },
        ),
        txParams(TX_ID),
      )
      expect(res.status).toBe(200)
      expect(createSupplierInvPmtJE).toHaveBeenCalledTimes(1)
      const paymentAccountArg = createSupplierInvPmtJE.mock.calls[0][8]
      expect(paymentAccountArg).toBe('1940')
    })

    it('ignores a stale last_supplier_payment_account setting and uses the linked cash account', async () => {
      mockServiceClient.mockReturnValue(
        makeFlexibleSupabase({
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          transactions: {
            data: {
              id: TX_ID,
              amount: -1001,
              date: '2026-02-01',
              currency: 'SEK',
              supplier_invoice_id: null,
              journal_entry_id: null,
              cash_account_id: 'ca-1930',
            },
            error: null,
          },
          supplier_invoices: [
            {
              data: {
                id: SI_ID,
                status: 'registered',
                total: 1001,
                paid_amount: 0,
                remaining_amount: 1001,
                currency: 'SEK',
                exchange_rate: null,
                supplier: { name: 'Acme', supplier_type: 'swedish_business' },
                items: [],
              },
              error: null,
            },
            { data: [{ id: SI_ID }], error: null },
          ],
          // Stale sticky setting from an earlier private-funds mark-paid
          // payment: must be ignored, this route never reads it.
          company_settings: {
            data: { accounting_method: 'accrual', last_supplier_payment_account: '2893' },
            error: null,
          },
          cash_accounts: { data: { ledger_account: '1930' }, error: null },
          supplier_invoice_payments: { data: null, error: null },
        }),
      )
      const res = await matchSIPOST(
        makeRequest(
          `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-supplier-invoice`,
          { supplier_invoice_id: SI_ID },
        ),
        txParams(TX_ID),
      )
      expect(res.status).toBe(200)
      const paymentAccountArg = createSupplierInvPmtJE.mock.calls[0][8]
      expect(paymentAccountArg).toBe('1930')
      expect(paymentAccountArg).not.toBe('2893')
    })

    it('defaults to 1930 when the transaction has no linked cash account', async () => {
      mockServiceClient.mockReturnValue(
        makeFlexibleSupabase({
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          transactions: {
            data: {
              id: TX_ID,
              amount: -750,
              date: '2026-02-01',
              currency: 'SEK',
              supplier_invoice_id: null,
              journal_entry_id: null,
              cash_account_id: null,
            },
            error: null,
          },
          supplier_invoices: [
            {
              data: {
                id: SI_ID,
                status: 'registered',
                total: 750,
                paid_amount: 0,
                remaining_amount: 750,
                currency: 'SEK',
                exchange_rate: null,
                supplier: { name: 'Acme', supplier_type: 'swedish_business' },
                items: [],
              },
              error: null,
            },
            { data: [{ id: SI_ID }], error: null },
          ],
          company_settings: { data: { accounting_method: 'accrual' }, error: null },
          supplier_invoice_payments: { data: null, error: null },
        }),
      )
      const res = await matchSIPOST(
        makeRequest(
          `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-supplier-invoice`,
          { supplier_invoice_id: SI_ID },
        ),
        txParams(TX_ID),
      )
      expect(res.status).toBe(200)
      const paymentAccountArg = createSupplierInvPmtJE.mock.calls[0][8]
      expect(paymentAccountArg).toBe('1930')
    })

    it('aborts with 500 BOOKKEEPING_DATABASE_ERROR when the cash_accounts lookup errors, mutating nothing', async () => {
      mockServiceClient.mockReturnValue(
        makeFlexibleSupabase({
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          transactions: {
            data: {
              id: TX_ID,
              amount: -600,
              date: '2026-02-01',
              currency: 'SEK',
              supplier_invoice_id: null,
              journal_entry_id: null,
              cash_account_id: 'ca-broken',
            },
            error: null,
          },
          supplier_invoices: {
            data: {
              id: SI_ID,
              status: 'registered',
              total: 600,
              paid_amount: 0,
              remaining_amount: 600,
              currency: 'SEK',
              exchange_rate: null,
              supplier: { name: 'Acme', supplier_type: 'swedish_business' },
              items: [],
            },
            error: null,
          },
          company_settings: { data: { accounting_method: 'accrual' }, error: null },
          cash_accounts: { data: null, error: { message: 'connection reset' } },
        }),
      )
      const res = await matchSIPOST(
        makeRequest(
          `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-supplier-invoice`,
          { supplier_invoice_id: SI_ID },
        ),
        txParams(TX_ID),
      )
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.error.code).toBe('BOOKKEEPING_DATABASE_ERROR')
      expect(createSupplierInvPmtJE).not.toHaveBeenCalled()
    })

    it('returns 400 ACCOUNTS_NOT_IN_CHART when the linked cash account is deactivated in the kontoplan', async () => {
      mockServiceClient.mockReturnValue(
        makeFlexibleSupabase({
          company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
          transactions: {
            data: {
              id: TX_ID,
              amount: -5000,
              date: '2026-05-12',
              currency: 'SEK',
              supplier_invoice_id: null,
              journal_entry_id: null,
              cash_account_id: 'ca-1940',
            },
            error: null,
          },
          supplier_invoices: {
            data: {
              id: SI_ID,
              status: 'approved',
              total: 5000,
              paid_amount: 0,
              remaining_amount: 5000,
              currency: 'SEK',
              exchange_rate: null,
              supplier: { name: 'Acme', supplier_type: 'swedish_business' },
              items: [],
            },
            error: null,
          },
          company_settings: { data: { accounting_method: 'accrual' }, error: null },
          cash_accounts: { data: { ledger_account: '1940' }, error: null },
        }),
      )
      // Simulate the 1940 account existing in cash_accounts but having been
      // deactivated in chart_of_accounts since.
      findMissingAccountsMock.mockResolvedValueOnce(['1940'])

      const res = await matchSIPOST(
        makeRequest(
          `https://x.test/api/v1/companies/${COMPANY_ID}/transactions/${TX_ID}/match-supplier-invoice`,
          { supplier_invoice_id: SI_ID },
        ),
        txParams(TX_ID),
      )
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error.code).toBe('ACCOUNTS_NOT_IN_CHART')
      expect(body.error.details.account_numbers).toEqual(['1940'])
      // Engine and invoice/transaction updates must NOT run: the match stays
      // retryable rather than posting a payment against a dead account.
      expect(createSupplierInvPmtJE).not.toHaveBeenCalled()
    })
  })
})
