/**
 * The invoice-suggestion guards' plus-minus 2 % band and the column it is
 * applied to must share a unit.
 *
 * `transactions.amount` is denominated in `transactions.currency`, while
 * `supplier_invoices.remaining_amount` / `invoices.remaining_amount` are
 * denominated in the INVOICE's currency. At roughly 11,50 SEK/EUR a band built
 * around a EUR bank row and applied to a kronor `remaining_amount` column is
 * off by a factor of eleven: it matches nothing (the user books straight to
 * 244x/151x and is later lured into a duplicate payment) or it points at an
 * unrelated invoice.
 *
 * These tests assert the FILTER VALUES the route actually sends. The shared
 * `createQueuedMockSupabase` helper drops filter arguments, so a response-shape
 * assertion alone passes against the pre-fix band whenever the queued page is
 * empty. The finding lives entirely in the arguments.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createMockRequest, parseJsonResponse, createMockRouteParams, makeTransaction } from '@/tests/helpers'

/** One recorded query: which table, and every filter argument it received. */
type RecordedQuery = { table: string; calls: Record<string, unknown[][]> }

/**
 * Chainable Supabase stub that RECORDS each query's filter arguments and serves
 * one queued page per table, in call order. Keyed by table so an unrelated
 * lookup elsewhere in the route does not shift the assertions.
 */
function createRecordingSupabase(pages: Record<string, Array<{ data?: unknown; error?: unknown }>>) {
  const queries: RecordedQuery[] = []
  const queues: Record<string, Array<{ data: unknown; error: unknown }>> = {}
  for (const [table, list] of Object.entries(pages)) {
    queues[table] = list.map((r) => ({ data: r.data ?? null, error: r.error ?? null }))
  }

  const from = (table: string) => {
    const result = queues[table]?.shift() ?? { data: null, error: null }
    const calls: Record<string, unknown[][]> = {}
    queries.push({ table, calls })
    const chain: unknown = new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve(result)
          }
          return (...args: unknown[]) => {
            ;(calls[prop] ??= []).push(args)
            return chain
          }
        },
      },
    )
    return chain
  }

  const supabase = {
    from: vi.fn(from),
    rpc: vi.fn(() => from('__rpc')),
    auth: { getUser: vi.fn() },
  }

  return { supabase, queries }
}

const initial = createRecordingSupabase({})
let mockSupabase = initial.supabase
let recorded: RecordedQuery[] = initial.queries

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase as unknown as SupabaseClient),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockBuildMappingResultFromCategory = vi.fn()
vi.mock('@/lib/bookkeeping/category-mapping', () => ({
  buildMappingResultFromCategory: (...args: unknown[]) => mockBuildMappingResultFromCategory(...args),
}))

const mockCreateTransactionJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/transaction-entries', () => ({
  createTransactionJournalEntry: (...args: unknown[]) => mockCreateTransactionJournalEntry(...args),
}))

// Only the DB-backed detector is stubbed; the pure helpers the route imports
// from this module (resolveTransactionAmountSek) keep their real behaviour.
const mockDetectDup = vi.fn()
vi.mock('@/lib/transactions/booking-duplicate-detection', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/transactions/booking-duplicate-detection')>()),
  detectBookingDuplicate: (...args: unknown[]) => mockDetectDup(...args),
}))

vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue('evt-1'),
}))

vi.mock('@/lib/bookkeeping/mapping-engine', () => ({
  saveUserMappingRule: vi.fn().mockResolvedValue(undefined),
  applySettlementAccount: (result: unknown) => result,
}))

vi.mock('@/lib/bookkeeping/counterparty-templates', () => ({
  upsertCounterpartyTemplate: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({
  cancelOrphanedPaymentEntry: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/bookkeeping/account-validation', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/account-validation')>(
    '@/lib/bookkeeping/account-validation',
  )
  return { ...actual, findUnresolvableAccounts: vi.fn().mockResolvedValue([]) }
})

import { eventBus } from '@/lib/events'
import { POST } from '../route'

function useSupabase(pages: Record<string, Array<{ data?: unknown; error?: unknown }>>) {
  const next = createRecordingSupabase(pages)
  mockSupabase = next.supabase
  recorded = next.queries
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
}

const settingsPage = { data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 } }

const baseMapping = {
  rule: null,
  debit_account: '6200',
  credit_account: '1930',
  risk_level: 'NONE',
  confidence: 1,
  requires_review: false,
  default_private: false,
  vat_lines: [],
  description: 'Test',
}

const supplierInvoiceRow = (over: Record<string, unknown> = {}) => ({
  id: 'si-1',
  supplier_invoice_number: 'INV-2026-0042',
  invoice_date: '2026-05-01',
  remaining_amount: 11500,
  total: 11500,
  currency: 'SEK',
  total_sek: 11500,
  exchange_rate: null,
  supplier: { name: 'Leverantör AB' },
  ...over,
})

const customerInvoiceRow = (over: Record<string, unknown> = {}) => ({
  id: 'inv-1',
  invoice_number: '2026-0042',
  invoice_date: '2026-05-01',
  due_date: '2026-05-31',
  remaining_amount: 11500,
  total: 11500,
  currency: 'SEK',
  total_sek: 11500,
  exchange_rate: null,
  customer: { name: 'Acme AB' },
  ...over,
})

const categorize = async (category: string) => {
  const request = createMockRequest('/api/transactions/tx-1/categorize', {
    method: 'POST',
    body: { is_business: true, category },
  })
  return POST(request, createMockRouteParams({ id: 'tx-1' }))
}

const queriesOn = (table: string) => recorded.filter((q) => q.table === table)

describe('POST /api/transactions/[id]/categorize: suggestion band units', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    mockDetectDup.mockResolvedValue(null)
    mockBuildMappingResultFromCategory.mockReturnValue(baseMapping)
  })

  it('SEK payment to 2440: one kronor-banded sweep, byte-identical to the pre-fix query', async () => {
    useSupabase({
      transactions: [
        {
          data: makeTransaction({
            id: 'tx-1',
            amount: -1000,
            currency: 'SEK',
            amount_sek: null,
            exchange_rate: null,
            merchant_name: 'Leverantör AB',
            reference: null,
            cash_account_id: null,
            journal_entry_id: null,
          }),
        },
      ],
      company_settings: [settingsPage],
      suppliers: [{ data: [{ id: 'sup-1' }] }],
      supplier_invoices: [{ data: [supplierInvoiceRow({ remaining_amount: 1000, total: 1000, total_sek: 1000 })] }],
    })
    mockBuildMappingResultFromCategory.mockReturnValue({ ...baseMapping, debit_account: '2440' })

    const response = await categorize('expense_software')
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('TX_CATEGORIZE_SUGGEST_SI_MATCH')

    expect(queriesOn('supplier_invoices')).toHaveLength(1)
    const q = queriesOn('supplier_invoices')[0].calls
    expect(q.gte).toContainEqual(['remaining_amount', 980])
    expect(q.lte).toContainEqual(['remaining_amount', 1020])
    expect(q.or).toEqual([['currency.is.null,currency.eq.SEK']])
  })

  it('EUR payment to 2440: EUR invoices banded in EUR, kronor invoices banded in kronor', async () => {
    useSupabase({
      transactions: [
        {
          data: makeTransaction({
            id: 'tx-1',
            amount: -1000,
            currency: 'EUR',
            amount_sek: null,
            exchange_rate: 11.5,
            merchant_name: 'Leverantör AB',
            reference: null,
            cash_account_id: null,
            journal_entry_id: null,
          }),
        },
      ],
      company_settings: [settingsPage],
      suppliers: [{ data: [{ id: 'sup-1' }] }],
      // EUR sweep empty; the kronor sweep finds the 11 500 kr invoice this
      // payment actually settles.
      supplier_invoices: [{ data: [] }, { data: [supplierInvoiceRow()] }],
    })
    mockBuildMappingResultFromCategory.mockReturnValue({ ...baseMapping, debit_account: '2440' })

    const response = await categorize('expense_software')
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { candidates: Array<{ supplier_invoice_id: string }> } }
    }>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('TX_CATEGORIZE_SUGGEST_SI_MATCH')
    expect(body.error.details.candidates.map((c) => c.supplier_invoice_id)).toEqual(['si-1'])

    expect(queriesOn('supplier_invoices')).toHaveLength(2)
    const eur = queriesOn('supplier_invoices')[0].calls
    expect(eur.or).toEqual([['currency.eq.EUR']])
    expect(eur.gte).toContainEqual(['remaining_amount', 980])
    expect(eur.lte).toContainEqual(['remaining_amount', 1020])

    const sek = queriesOn('supplier_invoices')[1].calls
    expect(sek.or).toEqual([['currency.is.null,currency.eq.SEK']])
    // 1 000 EUR x 11,50 = 11 500 kr. The pre-fix query asked kronor invoices
    // for 980..1020 and found nothing.
    expect(sek.gte).toContainEqual(['remaining_amount', 11270])
    expect(sek.lte).toContainEqual(['remaining_amount', 11730])
    // The per-row re-check pro-rates total_sek; a narrow projection would make
    // it read `undefined` and silently treat every invoice as kronor.
    expect(sek.select?.[0][0]).toContain('total_sek')
    expect(sek.select?.[0][0]).toContain('exchange_rate')
    expect(sek.select?.[0][0]).toContain('currency')
  })

  it('EUR receipt to 1510: customer invoices are banded per currency too', async () => {
    useSupabase({
      transactions: [
        {
          data: makeTransaction({
            id: 'tx-1',
            amount: 1000,
            currency: 'EUR',
            amount_sek: 11500,
            exchange_rate: null,
            merchant_name: 'Acme AB',
            description: 'Inbetalning Acme AB',
            reference: null,
            cash_account_id: null,
            journal_entry_id: null,
          }),
        },
      ],
      company_settings: [settingsPage],
      customers: [{ data: [{ id: 'cust-1' }] }, { data: [{ id: 'cust-1' }] }],
      invoices: [{ data: [] }, { data: [customerInvoiceRow()] }],
    })
    mockBuildMappingResultFromCategory.mockReturnValue({
      ...baseMapping,
      debit_account: '1930',
      credit_account: '1510',
    })

    const response = await categorize('income_services')
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { candidates: Array<{ invoice_id: string }> } }
    }>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('TX_CATEGORIZE_SUGGEST_CI_MATCH')
    expect(body.error.details.candidates.map((c) => c.invoice_id)).toEqual(['inv-1'])

    expect(queriesOn('invoices')).toHaveLength(2)
    const eur = queriesOn('invoices')[0].calls
    expect(eur.or).toEqual([['currency.eq.EUR']])
    expect(eur.gte).toContainEqual(['remaining_amount', 980])
    expect(eur.lte).toContainEqual(['remaining_amount', 1020])

    const sek = queriesOn('invoices')[1].calls
    expect(sek.or).toEqual([['currency.is.null,currency.eq.SEK']])
    expect(sek.gte).toContainEqual(['remaining_amount', 11270])
    expect(sek.lte).toContainEqual(['remaining_amount', 11730])
  })

  it('EUR payment with no stored rate: only the EUR sweep runs, kronor invoices are excluded', async () => {
    useSupabase({
      transactions: [
        {
          data: makeTransaction({
            id: 'tx-1',
            amount: -1000,
            currency: 'EUR',
            amount_sek: null,
            exchange_rate: null,
            merchant_name: 'Leverantör AB',
            reference: null,
            cash_account_id: null,
            journal_entry_id: null,
          }),
        },
        // The post-suggestion status update.
        { data: [{ id: 'tx-1' }] },
      ],
      company_settings: [settingsPage],
      suppliers: [{ data: [{ id: 'sup-1' }] }],
      // The single EUR sweep returns a kronor invoice anyway (this stub ignores
      // the filters): the shared-unit re-check must drop it rather than read
      // 1 000 kr as 1 000 EUR.
      supplier_invoices: [{ data: [supplierInvoiceRow({ remaining_amount: 1000, total: 1000, total_sek: 1000 })] }],
      fiscal_periods: [{ data: [{ id: 'period-1' }] }],
    })
    mockBuildMappingResultFromCategory.mockReturnValue({ ...baseMapping, debit_account: '2440' })
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })

    const response = await categorize('expense_software')
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(queriesOn('supplier_invoices')).toHaveLength(1)
    expect(queriesOn('supplier_invoices')[0].calls.or).toEqual([['currency.eq.EUR']])
  })
})
