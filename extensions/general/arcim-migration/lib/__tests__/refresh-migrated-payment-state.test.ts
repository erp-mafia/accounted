import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The repair pass for migrated supplier invoices whose payment state the
 * import could not read (Bokio, 2026-09-14). It asks the provider rather than
 * guessing, writes only the four payment columns, and never touches a row
 * that is already booked or paid here.
 */

vi.mock('@/lib/providers/resolve-consent', () => ({
  resolveConsent: vi.fn().mockResolvedValue({
    consent: { provider: 'bokio' },
    accessToken: 'tok',
    providerCompanyId: 'bokio-company-1',
  }),
}))

vi.mock('@/lib/providers/provider-data-fetcher', () => ({
  fetchSupplierInvoicesDirect: vi.fn(),
}))

vi.mock('@/lib/supabase/fetch-all', () => ({ fetchAllRows: vi.fn() }))

import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchSupplierInvoicesDirect } from '@/lib/providers/provider-data-fetcher'
import { refreshMigratedSupplierPaymentState } from '../refresh-migrated-payment-state'

const mFetchAll = fetchAllRows as Mock
const mFetchProvider = fetchSupplierInvoicesDirect as Mock

/** A Bokio-shaped supplier invoice DTO: balance-derived payment state, no enum. */
function providerInvoice(invoiceNumber: string, issueDate: string, total: number, remaining: number) {
  return {
    id: `p-${invoiceNumber}`,
    invoiceNumber,
    issueDate,
    currencyCode: 'SEK',
    legalMonetaryTotal: { payableAmount: { value: total, currencyCode: 'SEK' } },
    paymentStatus: {
      paid: total > 0 && remaining <= 0,
      balance: { value: remaining, currencyCode: 'SEK' },
      source: 'balance' as const,
    },
  }
}

function openRow(id: string, invoiceNumber: string, invoiceDate: string, total: number) {
  return { id, supplier_invoice_number: invoiceNumber, invoice_date: invoiceDate, total }
}

/** Records every update() the pass issues, and the filters it scoped them with. */
function trackingSupabase() {
  const updates: { values: Record<string, unknown>; filters: Record<string, unknown> }[] = []
  const selectFilters: Record<string, unknown> = {}

  const supabase = {
    from: vi.fn((table: string) => ({
      update: (values: Record<string, unknown>) => {
        const filters: Record<string, unknown> = { table }
        updates.push({ values, filters })
        // .eq(...).eq(...) then awaited: the last link resolves.
        const chain = {
          eq: (column: string, value: unknown) => {
            filters[column] = value
            return chain
          },
          then: (resolve: (value: { error: null }) => unknown) => resolve({ error: null }),
        }
        return chain
      },
      select: () => {
        const chain: Record<string, unknown> = {}
        const add = (key: string) => (column: string, value?: unknown) => {
          selectFilters[`${key}:${column}`] = value ?? null
          return chain
        }
        chain.eq = add('eq')
        chain.is = add('is')
        chain.in = add('in')
        chain.order = () => chain
        chain.range = () => chain
        return chain
      },
    })),
  } as unknown as SupabaseClient

  return { supabase, updates, selectFilters }
}

describe('refreshMigratedSupplierPaymentState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes the provider payment state onto an invoice the provider reports as settled', async () => {
    mFetchProvider.mockResolvedValue([providerInvoice('L-100', '2020-08-03', 1250, 0)])
    mFetchAll.mockResolvedValue([openRow('si-1', 'L-100', '2020-08-03', 1250)])
    const { supabase, updates } = trackingSupabase()

    const result = await refreshMigratedSupplierPaymentState({
      supabase,
      companyId: 'company-1',
      consentId: 'consent-1',
    })

    expect(updates).toHaveLength(1)
    expect(updates[0].values).toEqual({
      status: 'paid',
      paid_amount: 1250,
      remaining_amount: 0,
      paid_at: '2020-08-03',
    })
    // Company-scoped and row-scoped: never a blanket update.
    expect(updates[0].filters).toMatchObject({ table: 'supplier_invoices', id: 'si-1', company_id: 'company-1' })
    expect(result).toEqual({
      providerInvoices: 1,
      matched: 1,
      updated: 1,
      unchanged: 0,
      unmatched: 0,
      dryRun: false,
    })
  })

  it('writes a partial payment as partially_paid', async () => {
    mFetchProvider.mockResolvedValue([providerInvoice('L-101', '2021-01-05', 1000, 400)])
    mFetchAll.mockResolvedValue([openRow('si-2', 'L-101', '2021-01-05', 1000)])
    const { supabase, updates } = trackingSupabase()

    const result = await refreshMigratedSupplierPaymentState({
      supabase, companyId: 'company-1', consentId: 'consent-1',
    })

    expect(updates[0].values).toMatchObject({ status: 'partially_paid', paid_amount: 600, remaining_amount: 400 })
    expect(result.updated).toBe(1)
  })

  it('leaves an invoice the provider still reports as open exactly as it is', async () => {
    mFetchProvider.mockResolvedValue([providerInvoice('L-102', '2021-02-05', 1000, 1000)])
    mFetchAll.mockResolvedValue([openRow('si-3', 'L-102', '2021-02-05', 1000)])
    const { supabase, updates } = trackingSupabase()

    const result = await refreshMigratedSupplierPaymentState({
      supabase, companyId: 'company-1', consentId: 'consent-1',
    })

    expect(updates).toHaveLength(0)
    expect(result).toMatchObject({ matched: 1, updated: 0, unchanged: 1 })
  })

  it('reads only rows with no vouchers, no payment, no credit note and an open status', async () => {
    mFetchProvider.mockResolvedValue([])
    mFetchAll.mockResolvedValue([])
    const { supabase, selectFilters } = trackingSupabase()

    await refreshMigratedSupplierPaymentState({ supabase, companyId: 'company-1', consentId: 'consent-1' })

    // fetchAllRows is mocked, so run the query builder the pass handed it.
    const build = mFetchAll.mock.calls[0][0] as (range: { from: number; to: number }) => unknown
    build({ from: 0, to: 999 })
    expect(selectFilters).toMatchObject({
      'eq:company_id': 'company-1',
      'is:registration_journal_entry_id': null,
      'is:payment_journal_entry_id': null,
      'eq:paid_amount': 0,
      'eq:is_credit_note': false,
    })
    expect(selectFilters['in:status']).toEqual(['registered', 'approved', 'overdue'])
  })

  it('skips an invoice number that is not unique on either side', async () => {
    mFetchProvider.mockResolvedValue([
      providerInvoice('L-200', '2021-03-01', 500, 0),
      providerInvoice('L-200', '2021-03-01', 900, 0),
    ])
    mFetchAll.mockResolvedValue([openRow('si-4', 'L-200', '2021-03-01', 500)])
    const { supabase, updates } = trackingSupabase()

    const result = await refreshMigratedSupplierPaymentState({
      supabase, companyId: 'company-1', consentId: 'consent-1',
    })

    expect(updates).toHaveLength(0)
    expect(result).toMatchObject({ providerInvoices: 2, matched: 0, updated: 0, unmatched: 2 })
  })

  it('joins on the date as well as the number, so a reused number settles nothing', async () => {
    mFetchProvider.mockResolvedValue([providerInvoice('1001', '2021-04-01', 500, 0)])
    mFetchAll.mockResolvedValue([openRow('si-5', '1001', '2023-09-09', 500)])
    const { supabase, updates } = trackingSupabase()

    const result = await refreshMigratedSupplierPaymentState({
      supabase, companyId: 'company-1', consentId: 'consent-1',
    })

    expect(updates).toHaveLength(0)
    expect(result).toMatchObject({ matched: 0, unmatched: 1 })
  })

  it('does not settle a local row that carries no amount', async () => {
    mFetchProvider.mockResolvedValue([providerInvoice('L-300', '2019-06-01', 0, 0)])
    mFetchAll.mockResolvedValue([openRow('si-6', 'L-300', '2019-06-01', 0)])
    const { supabase, updates } = trackingSupabase()

    const result = await refreshMigratedSupplierPaymentState({
      supabase, companyId: 'company-1', consentId: 'consent-1',
    })

    expect(updates).toHaveLength(0)
    expect(result).toMatchObject({ matched: 1, updated: 0, unchanged: 1 })
  })

  it('writes nothing on a dry run but reports what it would write', async () => {
    mFetchProvider.mockResolvedValue([providerInvoice('L-400', '2020-08-03', 1250, 0)])
    mFetchAll.mockResolvedValue([openRow('si-7', 'L-400', '2020-08-03', 1250)])
    const { supabase, updates } = trackingSupabase()

    const result = await refreshMigratedSupplierPaymentState({
      supabase, companyId: 'company-1', consentId: 'consent-1', dryRun: true,
    })

    expect(updates).toHaveLength(0)
    expect(result).toMatchObject({ matched: 1, updated: 1, dryRun: true })
  })
})
