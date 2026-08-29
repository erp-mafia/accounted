import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The /reconcile re-run for registration vouchers (#1463): re-fetch both
 * registers from the provider, join them to the invoices that are still
 * unlinked here, and hand the pairs to the core linker. The joins are strict
 * (sales by invoice number, supplier by number + date, unique on both sides)
 * because a wrong join hands the linker a plausible but wrong candidate.
 */

vi.mock('@/lib/providers/resolve-consent', () => ({
  resolveConsent: vi.fn().mockResolvedValue({
    consent: { provider: 'fortnox' },
    accessToken: 'tok',
    providerCompanyId: undefined,
  }),
}))

vi.mock('@/lib/providers/provider-data-fetcher', () => ({
  fetchSalesInvoicesHydrated: vi.fn(),
  fetchSupplierInvoicesHydrated: vi.fn(),
}))

vi.mock('@/lib/supabase/fetch-all', () => ({ fetchAllRows: vi.fn() }))

vi.mock('@/lib/invoices/link-migrated-registration-vouchers', () => ({
  linkMigratedRegistrationVouchers: vi.fn(),
}))

import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  fetchSalesInvoicesHydrated,
  fetchSupplierInvoicesHydrated,
} from '@/lib/providers/provider-data-fetcher'
import { linkMigratedRegistrationVouchers } from '@/lib/invoices/link-migrated-registration-vouchers'
import { relinkRegistrationVouchers } from '../relink-registration-vouchers'

const mFetchAll = fetchAllRows as Mock
const mSales = fetchSalesInvoicesHydrated as Mock
const mSupplier = fetchSupplierInvoicesHydrated as Mock
const mLink = linkMigratedRegistrationVouchers as Mock

const HYDRATION = { needed: 0, hydrated: 0, failed: 0, skippedForBudget: 0 }
const EMPTY_COUNTS = {
  scanned: 0, linked: 0, noRef: 0, unresolved: 0, ambiguous: 0, amountMismatch: 0, alreadyLinked: 0, reports: [],
}

function providerSales(invoiceNumber: string, ref?: { series: string | null; number: number }) {
  return { invoiceNumber, issueDate: '2025-03-14', sourceVoucher: ref }
}

function providerSupplier(invoiceNumber: string, issueDate: string, ref?: { series: string | null; number: number }) {
  return { invoiceNumber, issueDate, sourceVoucher: ref }
}

/** fetchAllRows is called twice: unlinked sales rows, then unlinked supplier rows. */
function queueDb(sales: unknown[], supplier: unknown[]) {
  mFetchAll.mockReset()
  mFetchAll.mockResolvedValueOnce(sales).mockResolvedValueOnce(supplier)
}

const supabase = {} as unknown as SupabaseClient

describe('relinkRegistrationVouchers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mLink.mockImplementation(async ({ invoices }: { invoices: unknown[] }) => ({
      ...EMPTY_COUNTS,
      scanned: invoices.length,
    }))
  })

  it('joins provider invoices to the unlinked rows and hands the pairs to the linker', async () => {
    mSales.mockResolvedValue({
      invoices: [providerSales('1001', { series: 'A', number: 329 }), providerSales('9999')],
      hydration: HYDRATION,
    })
    mSupplier.mockResolvedValue({
      invoices: [providerSupplier('L-77', '2025-05-02', { series: 'B', number: 5 })],
      hydration: HYDRATION,
    })
    queueDb(
      [{ id: 'inv-1', invoice_number: '1001', invoice_date: '2025-03-14', total_sek: 1000 }],
      [{ id: 'si-1', supplier_invoice_number: 'L-77', invoice_date: '2025-05-02', total_sek: 2500 }],
    )

    const result = await relinkRegistrationVouchers({ supabase, companyId: 'company-1', consentId: 'consent-1' })

    expect(mLink).toHaveBeenCalledTimes(1)
    expect(mLink.mock.calls[0][0]).toMatchObject({ companyId: 'company-1', dryRun: false })
    expect(mLink.mock.calls[0][0].invoices).toEqual([
      {
        invoiceId: 'inv-1',
        kind: 'customer',
        sourceVoucher: { series: 'A', number: 329 },
        invoiceDate: '2025-03-14',
        totalSek: 1000,
        invoiceNumber: '1001',
      },
      {
        invoiceId: 'si-1',
        kind: 'supplier',
        sourceVoucher: { series: 'B', number: 5 },
        invoiceDate: '2025-05-02',
        totalSek: 2500,
        invoiceNumber: 'L-77',
      },
    ])
    expect(result).toMatchObject({ providerInvoices: 3, matched: 2, unmatched: 1, scanned: 2 })
  })

  it('refuses to join a supplier invoice number shared by two rows on either side', async () => {
    mSales.mockResolvedValue({ invoices: [], hydration: HYDRATION })
    mSupplier.mockResolvedValue({
      invoices: [
        providerSupplier('1001', '2025-05-02', { series: 'B', number: 5 }),
        providerSupplier('1001', '2025-05-02', { series: 'B', number: 6 }),
        providerSupplier('2002', '2025-06-01', { series: 'B', number: 7 }),
      ],
      hydration: HYDRATION,
    })
    queueDb(
      [],
      [
        { id: 'si-a', supplier_invoice_number: '1001', invoice_date: '2025-05-02', total_sek: 100 },
        { id: 'si-b', supplier_invoice_number: '2002', invoice_date: '2025-06-01', total_sek: 200 },
        { id: 'si-c', supplier_invoice_number: '2002', invoice_date: '2025-06-01', total_sek: 300 },
      ],
    )

    const result = await relinkRegistrationVouchers({ supabase, companyId: 'company-1', consentId: 'consent-1' })

    expect(mLink.mock.calls[0][0].invoices).toEqual([])
    expect(result).toMatchObject({ providerInvoices: 3, matched: 0, unmatched: 3 })
  })

  it('reads only rows whose link is still NULL and passes dryRun through', async () => {
    mSales.mockResolvedValue({ invoices: [], hydration: HYDRATION })
    mSupplier.mockResolvedValue({ invoices: [], hydration: HYDRATION })

    // Capture the query builders to assert the NULL guards.
    const calls: { table: string; method: string; args: unknown[] }[] = []
    const chain = (table: string): unknown => new Proxy({}, {
      get: (_t, prop) => (...args: unknown[]) => {
        calls.push({ table, method: String(prop), args })
        return chain(table)
      },
    })
    const capturing = { from: (table: string) => chain(table) } as unknown as SupabaseClient
    mFetchAll.mockReset()
    mFetchAll.mockImplementation(async (queryFn: (r: { from: number; to: number }) => unknown) => {
      queryFn({ from: 0, to: 999 })
      return []
    })

    await relinkRegistrationVouchers({ supabase: capturing, companyId: 'company-1', consentId: 'consent-1', dryRun: true })

    expect(calls).toEqual(expect.arrayContaining([
      { table: 'invoices', method: 'is', args: ['journal_entry_id', null] },
      { table: 'invoices', method: 'eq', args: ['company_id', 'company-1'] },
      { table: 'supplier_invoices', method: 'is', args: ['registration_journal_entry_id', null] },
      { table: 'supplier_invoices', method: 'eq', args: ['company_id', 'company-1'] },
    ]))
    expect(mLink.mock.calls[0][0]).toMatchObject({ dryRun: true, invoices: [] })
  })
})
