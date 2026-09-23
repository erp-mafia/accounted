/**
 * Exchange-rate resolution at the pending-operation COMMIT boundary.
 *
 * One finding in three executors: each wrote a foreign-currency row with no
 * usable SEK translation, and nothing errored.
 *
 *  - create_transaction: no amount_sek, no exchange_rate at all. The
 *    categorization path then resolves the line through the LENIENT
 *    resolveSekAmount(), which falls back to the RAW foreign number, so a
 *    1500 USD row debited 1500 kr while buildCurrencyMetadata() stamped the
 *    same line `currency: USD, amount_in_currency: 1500`. The verifikation
 *    balances (every leg is scaled by the same wrong factor), so no DB trigger
 *    and no validator objects.
 *  - create_invoice: fetched a rate but with NO date (today's kurs on a
 *    back-dated invoice) and NO supabase client (bypassing the exchange_rates
 *    cache), and stored NULL when the fetch produced nothing. It also left
 *    total_sek NULL for every ordinary SEK invoice.
 *  - create_supplier_invoice_from_inbox: took params.exchange_rate verbatim
 *    with no fetch at all, the fourth supplier-invoice writer with that shape.
 *
 * The fix mirrors lib/transactions/ingest.ts on all three:
 * `fetchExchangeRate(currency, new Date(rowDate), supabase)`, and a null result
 * is NEVER turned into a made-up number: the commit refuses, which is visible
 * to the approver who is still looking at the operation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { makeCustomer, makeJournalEntry, makeSupplierInvoice } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/currency/riksbanken', async () => {
  const actual = await vi.importActual<typeof import('@/lib/currency/riksbanken')>(
    '@/lib/currency/riksbanken',
  )
  return { ...actual, fetchExchangeRate: vi.fn() }
})

vi.mock('@/lib/bookkeeping/supplier-invoice-entries', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/supplier-invoice-entries')>(
    '@/lib/bookkeeping/supplier-invoice-entries',
  )
  return { ...actual, createSupplierInvoiceRegistrationEntry: vi.fn() }
})

vi.mock('@/lib/core/documents/document-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/core/documents/document-service')>(
    '@/lib/core/documents/document-service',
  )
  return { ...actual, linkToJournalEntry: vi.fn() }
})

import { commitPendingOperation } from '../commit'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { createSupplierInvoiceRegistrationEntry } from '@/lib/bookkeeping/supplier-invoice-entries'

/**
 * Queue-based supabase mock that also records every `.insert()` payload per
 * table and every `.rpc()` name, so a test can assert both what was written
 * and what was NOT reached (e.g. the arrival-number sequence).
 */
function createCapturingSupabase(results: Array<{ data?: unknown; error?: unknown }>) {
  const queue = [...results]
  const inserts: Record<string, unknown[]> = {}
  const rpcCalls: string[] = []

  const chainFor = (result: { data: unknown; error: unknown }, table: string) => {
    const chain: object = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve(result)
          }
          if (prop === 'insert') {
            return (payload: unknown) => {
              ;(inserts[table] ??= []).push(payload)
              return chain
            }
          }
          return () => chain
        },
      },
    )
    return chain
  }

  const next = () => {
    const raw = queue.shift() ?? { data: null, error: null }
    return { data: raw.data ?? null, error: raw.error ?? null }
  }

  const from = vi.fn((table: string) => chainFor(next(), table))
  const rpc = vi.fn((name: string) => {
    rpcCalls.push(name)
    return chainFor(next(), `rpc:${name}`)
  })

  return { supabase: { from, rpc }, inserts, rpcCalls }
}

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'create_transaction',
    status: 'pending',
    title: 'test',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    created_at: '2026-05-03T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-05-03T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

// ─── create_transaction ─────────────────────────────────────────────

describe('commitPendingOperation: create_transaction FX', () => {
  /** CAS claim → transactions insert → dispatcher update. */
  const txQueue = () => [
    { data: { id: 'op-1' } },
    { data: { id: 'tx-1' } },
    { data: null },
  ]

  it('a 1500 USD staged transaction commits with amount_sek and exchange_rate', async () => {
    vi.mocked(fetchExchangeRate).mockResolvedValueOnce({
      currency: 'USD',
      rate: 10.5,
      date: '2026-05-01',
    })
    const { supabase, inserts } = createCapturingSupabase(txQueue())

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        params: {
          date: '2026-05-01',
          amount: 1500,
          description: 'Stripe payout',
          currency: 'USD',
        },
      }),
    )

    expect(result.status).toBe('committed')
    expect(inserts['transactions']).toHaveLength(1)
    expect(inserts['transactions'][0]).toMatchObject({
      amount: 1500,
      currency: 'USD',
      // 1500 * 10.5, not 1500. Before the fix these three were absent from the
      // insert entirely, so the verifikat later debited 1500 kr.
      amount_sek: 15750,
      exchange_rate: 10.5,
      exchange_rate_date: '2026-05-01',
    })
  })

  it("fetches the rate for the row's OWN date, with the supabase client passed", async () => {
    vi.mocked(fetchExchangeRate).mockResolvedValueOnce({
      currency: 'EUR',
      rate: 11.5,
      date: '2025-11-14',
    })
    const { supabase } = createCapturingSupabase(txQueue())

    await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        params: {
          date: '2025-11-17',
          amount: -200,
          description: 'Hetzner',
          currency: 'EUR',
        },
      }),
    )

    expect(fetchExchangeRate).toHaveBeenCalledTimes(1)
    const [currency, date, client] = vi.mocked(fetchExchangeRate).mock.calls[0]
    expect(currency).toBe('EUR')
    // The transaction date, NOT "today": a back-dated row must not be stamped
    // with today's kurs.
    expect((date as Date).toISOString().split('T')[0]).toBe('2025-11-17')
    // Passed so exchange_rates acts as the read-through cache and as the
    // last-cached-observation fallback when Riksbanken rate-limits.
    expect(client).toBe(supabase)
  })

  it('refuses rather than writing a self-contradictory line when no rate is available', async () => {
    vi.mocked(fetchExchangeRate).mockResolvedValueOnce(null)
    const { supabase, inserts } = createCapturingSupabase([
      { data: { id: 'op-1' } }, // CAS claim
      { data: null }, // dispatcher reject/fail update
    ])

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        params: {
          date: '2026-05-01',
          amount: 1500,
          description: 'Stripe payout',
          currency: 'USD',
        },
      }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/växelkurs/i)
    expect(result.error).toMatch(/1 USD = 1 SEK/)
    // Nothing was written: no row that a later categorization could book 1:1.
    expect(inserts['transactions']).toBeUndefined()
  })

  it('refuses BEFORE creating the manual kassakonto, so nothing is left behind', async () => {
    vi.mocked(fetchExchangeRate).mockResolvedValueOnce(null)
    const { supabase, inserts } = createCapturingSupabase([
      { data: { id: 'op-1' } },
      { data: null },
    ])

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        params: {
          date: '2026-05-01',
          amount: -50,
          description: 'Wise card',
          currency: 'USD',
          ledger_account: '1935',
        },
      }),
    )

    expect(result.status).toBe('failed')
    expect(inserts['cash_accounts']).toBeUndefined()
    expect(inserts['transactions']).toBeUndefined()
  })

  it('a SEK transaction is unaffected: no rate lookup, no SEK columns', async () => {
    const { supabase, inserts } = createCapturingSupabase(txQueue())

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        params: {
          date: '2026-05-01',
          amount: -129.5,
          description: 'Telia',
          currency: 'SEK',
        },
      }),
    )

    expect(result.status).toBe('committed')
    expect(fetchExchangeRate).not.toHaveBeenCalled()
    expect(inserts['transactions'][0]).toMatchObject({
      amount: -129.5,
      currency: 'SEK',
      // amount already IS kronor; the column means "SEK translation of a
      // foreign amount". Mirrors lib/transactions/ingest.ts.
      amount_sek: null,
      exchange_rate: null,
      exchange_rate_date: null,
    })
  })
})

// ─── create_invoice ─────────────────────────────────────────────────

const customer = makeCustomer({ id: 'cust-1', customer_type: 'swedish_business' })

/** CAS claim → customers → company_settings → invoices insert →
 *  invoice_items insert → complete-invoice select → dispatcher update. */
function invoiceQueue() {
  return [
    { data: { id: 'op-1' } },
    { data: customer },
    { data: { vat_registered: true } },
    { data: { id: 'inv-1', invoice_number: null } },
    { data: null },
    { data: { id: 'inv-1' } },
    { data: null },
  ]
}

describe('commitPendingOperation: create_invoice FX', () => {
  it('translates a back-dated EUR invoice at the INVOICE DATE rate, via the cache', async () => {
    vi.mocked(fetchExchangeRate).mockResolvedValueOnce({
      currency: 'EUR',
      rate: 11.5,
      date: '2026-01-30',
    })
    const { supabase, inserts } = createCapturingSupabase(invoiceQueue())

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        operation_type: 'create_invoice',
        params: {
          customer_id: 'cust-1',
          currency: 'EUR',
          invoice_date: '2026-02-01',
          items: [{ description: 'Konsult', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
        },
      }),
    )

    expect(result.status).toBe('committed')
    const [currency, date, client] = vi.mocked(fetchExchangeRate).mock.calls[0]
    expect(currency).toBe('EUR')
    expect((date as Date).toISOString().split('T')[0]).toBe('2026-02-01')
    expect(client).toBe(supabase)

    expect(inserts['invoices'][0]).toMatchObject({
      currency: 'EUR',
      exchange_rate: 11.5,
      exchange_rate_date: '2026-01-30',
      subtotal: 1000,
      subtotal_sek: 11500,
      vat_amount: 250,
      vat_amount_sek: 2875,
      total: 1250,
      total_sek: 14375,
    })
  })

  it('refuses the create when no rate can be resolved', async () => {
    vi.mocked(fetchExchangeRate).mockResolvedValueOnce(null)
    const { supabase, inserts } = createCapturingSupabase([
      { data: { id: 'op-1' } },
      { data: customer },
      { data: { vat_registered: true } },
      { data: null }, // dispatcher fail update
    ])

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        operation_type: 'create_invoice',
        params: {
          customer_id: 'cust-1',
          currency: 'EUR',
          invoice_date: '2026-02-01',
          items: [{ description: 'Konsult', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
        },
      }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/växelkurs/i)
    // No invoice row, so no F-series number and no 1:1 posting downstream.
    expect(inserts['invoices']).toBeUndefined()
  })

  it('a SEK invoice gets total_sek === total instead of NULL', async () => {
    const { supabase, inserts } = createCapturingSupabase(invoiceQueue())

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        operation_type: 'create_invoice',
        params: {
          customer_id: 'cust-1',
          invoice_date: '2026-02-01',
          items: [{ description: 'Konsult', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
        },
      }),
    )

    expect(result.status).toBe('committed')
    expect(fetchExchangeRate).not.toHaveBeenCalled()
    expect(inserts['invoices'][0]).toMatchObject({
      currency: 'SEK',
      // 1 SEK = 1 SEK is not a rate, so the column stays NULL...
      exchange_rate: null,
      exchange_rate_date: null,
      // ...but the SEK columns are populated: leaving them NULL blanked every
      // SEK-reporting reader.
      subtotal: 1000,
      subtotal_sek: 1000,
      vat_amount: 250,
      vat_amount_sek: 250,
      total: 1250,
      total_sek: 1250,
    })
  })
})

// ─── create_supplier_invoice_from_inbox ─────────────────────────────

function inboxParams(overrides: Record<string, unknown> = {}) {
  return {
    inbox_item_id: 'inbox-1',
    supplier_id: 'supplier-1',
    document_id: null,
    supplier_invoice_number: 'INV-100',
    invoice_date: '2026-05-15',
    due_date: '2026-06-14',
    currency: 'SEK',
    exchange_rate: null,
    vat_treatment: 'standard_25',
    subtotal: 1000,
    vat_amount: 250,
    total: 1250,
    notes: null,
    items: [
      {
        line_number: 1,
        description: 'Konsulttjänst',
        quantity: 1,
        unit: 'st',
        unit_price: 1000,
        line_total: 1000,
        account_number: '6530',
        vat_rate: 0.25,
        vat_amount: 250,
      },
    ],
    ...overrides,
  }
}

/** CAS claim → inbox → supplier → [fx] → arrival RPC → supplier_invoices
 *  insert → items insert → company_settings → SI update → inbox update →
 *  dispatcher update. */
function inboxQueue() {
  return [
    { data: { id: 'op-1' } },
    { data: { id: 'inbox-1', created_supplier_invoice_id: null, status: 'ready' } },
    { data: { id: 'supplier-1', name: 'Leverantör AB', supplier_type: 'swedish_business' } },
    { data: 42 }, // get_next_arrival_number
    { data: makeSupplierInvoice({ id: 'inv-1', supplier_invoice_number: 'INV-100' }) },
    { data: null }, // items insert
    { data: { accounting_method: 'accrual' } },
    { data: null }, // supplier_invoices update with JE id
    { data: null }, // invoice_inbox_items update
    { data: null }, // dispatcher commit update
  ]
}

describe('commitPendingOperation: create_supplier_invoice_from_inbox FX', () => {
  it('fetches the rate when staging did not carry one (the fourth writer, now shared)', async () => {
    vi.mocked(createSupplierInvoiceRegistrationEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-1', voucher_number: 7 }),
    )
    vi.mocked(fetchExchangeRate).mockResolvedValueOnce({
      currency: 'EUR',
      rate: 11.5,
      date: '2026-05-15',
    })
    const { supabase, inserts } = createCapturingSupabase(inboxQueue())

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        operation_type: 'create_supplier_invoice_from_inbox',
        params: inboxParams({ currency: 'EUR', exchange_rate: null }),
      }),
    )

    expect(result.status).toBe('committed')
    const [currency, date, client] = vi.mocked(fetchExchangeRate).mock.calls[0]
    expect(currency).toBe('EUR')
    expect((date as Date).toISOString().split('T')[0]).toBe('2026-05-15')
    expect(client).toBe(supabase)

    expect(inserts['supplier_invoices'][0]).toMatchObject({
      currency: 'EUR',
      exchange_rate: 11.5,
      exchange_rate_date: '2026-05-15',
      subtotal_sek: 11500,
      vat_amount_sek: 2875,
      total_sek: 14375,
    })
  })

  it('refuses without burning an ankomstnummer when no rate can be resolved', async () => {
    vi.mocked(fetchExchangeRate).mockResolvedValueOnce(null)
    const { supabase, inserts, rpcCalls } = createCapturingSupabase([
      { data: { id: 'op-1' } },
      { data: { id: 'inbox-1', created_supplier_invoice_id: null, status: 'ready' } },
      { data: { id: 'supplier-1', name: 'EU Vendor SA', supplier_type: 'eu_business' } },
      { data: null }, // dispatcher fail update
    ])

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        operation_type: 'create_supplier_invoice_from_inbox',
        params: inboxParams({ currency: 'EUR', exchange_rate: null }),
      }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/växelkurs/i)
    expect(inserts['supplier_invoices']).toBeUndefined()
    // The sequence is only touched after the rate is settled.
    expect(rpcCalls).not.toContain('get_next_arrival_number')
  })

  it('trusts a staged rate verbatim, so the approved preview number is the number written', async () => {
    vi.mocked(createSupplierInvoiceRegistrationEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-2', voucher_number: 8 }),
    )
    const { supabase, inserts } = createCapturingSupabase(inboxQueue())

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        operation_type: 'create_supplier_invoice_from_inbox',
        params: inboxParams({ currency: 'EUR', exchange_rate: 11.2 }),
      }),
    )

    expect(result.status).toBe('committed')
    expect(fetchExchangeRate).not.toHaveBeenCalled()
    expect(inserts['supplier_invoices'][0]).toMatchObject({
      exchange_rate: 11.2,
      subtotal_sek: 11200,
      vat_amount_sek: 2800,
      total_sek: 14000,
    })
  })

  it('a SEK supplier invoice gets total_sek === total instead of NULL', async () => {
    vi.mocked(createSupplierInvoiceRegistrationEntry).mockResolvedValueOnce(
      makeJournalEntry({ id: 'je-3', voucher_number: 9 }),
    )
    const { supabase, inserts } = createCapturingSupabase(inboxQueue())

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({
        operation_type: 'create_supplier_invoice_from_inbox',
        params: inboxParams(),
      }),
    )

    expect(result.status).toBe('committed')
    expect(fetchExchangeRate).not.toHaveBeenCalled()
    expect(inserts['supplier_invoices'][0]).toMatchObject({
      currency: 'SEK',
      exchange_rate: null,
      exchange_rate_date: null,
      subtotal: 1000,
      subtotal_sek: 1000,
      vat_amount: 250,
      vat_amount_sek: 250,
      total: 1250,
      total_sek: 1250,
    })
  })
})
