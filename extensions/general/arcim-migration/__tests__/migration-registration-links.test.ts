import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

/**
 * Locks the registration-voucher link step of the migration (#1463): the
 * orchestrator collects the id of every invoice it inserted together with the
 * voucher ref the provider named, hands that list to the core linker once,
 * after both invoice steps, and carries the counts into the results. A
 * linker failure is recorded as a step error and never discards the invoices
 * that were already persisted.
 */

vi.mock('@/lib/providers/resolve-consent', () => ({
  resolveConsent: vi.fn().mockResolvedValue({
    consent: { provider: 'visma' },
    accessToken: 'tok',
    providerCompanyId: null,
  }),
}))

vi.mock('@/lib/providers/provider-data-fetcher', () => ({
  fetchCompanyInfoDirect: vi.fn(),
  fetchCustomersDirect: vi.fn(),
  fetchSuppliersDirect: vi.fn(),
  fetchSalesInvoicesHydrated: vi.fn(),
  fetchSupplierInvoicesHydrated: vi.fn(),
}))

vi.mock('@/lib/invoices/bulk-reconcile-supplier-vouchers', () => ({
  reconcileSupplierInvoiceVouchers: vi.fn(),
}))

vi.mock('@/lib/invoices/link-migrated-registration-vouchers', () => ({
  linkMigratedRegistrationVouchers: vi.fn(),
}))

vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: vi.fn().mockResolvedValue([]),
}))

// Inserts answer with deterministic ids so the collected inputs can be
// asserted; the per-row fallback itself has its own suite.
vi.mock('../lib/insert-fallback', () => ({
  insertWithPerRowFallback: vi.fn(async (_supabase: unknown, table: string, rows: Record<string, unknown>[]) => ({
    returned: rows.map((row, i) => ({
      id: `${table}-${i + 1}`,
      org_number: row.org_number ?? null,
      name: row.name ?? null,
    })),
    failedCount: 0,
    firstError: null,
  })),
}))

import { executeMigration } from '../lib/migration-orchestrator'
import {
  fetchSalesInvoicesHydrated,
  fetchSupplierInvoicesHydrated,
} from '@/lib/providers/provider-data-fetcher'
import { linkMigratedRegistrationVouchers } from '@/lib/invoices/link-migrated-registration-vouchers'
import type { SalesInvoiceDto, SupplierInvoiceDto } from '@/lib/providers/dto'

const mLink = linkMigratedRegistrationVouchers as Mock

const HYDRATION = { needed: 0, hydrated: 0, failed: 0, skippedForBudget: 0 }

function party(name: string) {
  return { name, identifications: [] }
}

function salesDto(over: Partial<SalesInvoiceDto> & { invoiceNumber: string }): SalesInvoiceDto {
  return {
    id: over.invoiceNumber,
    issueDate: '2025-03-14',
    dueDate: '2025-04-13',
    currencyCode: 'SEK',
    status: 'sent',
    supplier: party(''),
    customer: party('Kund AB'),
    lines: [],
    legalMonetaryTotal: { payableAmount: { value: 1000, currencyCode: 'SEK' } },
    taxTotal: { taxAmount: { value: 200, currencyCode: 'SEK' } },
    paymentStatus: { paid: false, balance: { value: 1000, currencyCode: 'SEK' } },
    ...over,
  }
}

function supplierDto(over: Partial<SupplierInvoiceDto> & { invoiceNumber: string }): SupplierInvoiceDto {
  return {
    id: over.invoiceNumber,
    issueDate: '2025-05-02',
    dueDate: '2025-06-01',
    currencyCode: 'SEK',
    status: 'booked',
    supplier: party('Leverantör AB'),
    buyer: party(''),
    lines: [],
    legalMonetaryTotal: { payableAmount: { value: 2500, currencyCode: 'SEK' } },
    taxTotal: { taxAmount: { value: 500, currencyCode: 'SEK' } },
    paymentStatus: { paid: false, balance: { value: 2500, currencyCode: 'SEK' } },
    ...over,
  }
}

const LINK_COUNTS = {
  scanned: 2, linked: 1, noRef: 1, refNotFetched: 0, unresolved: 0, ambiguous: 0, amountMismatch: 0, alreadyLinked: 0, reports: [],
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  const { supabase } = createQueuedMockSupabase()
  return {
    consentId: 'consent-1',
    companyId: 'company-1',
    userId: 'user-1',
    supabase: supabase as unknown as SupabaseClient,
    createHistoryClient: async () => ({ from: vi.fn() }) as unknown as Pick<SupabaseClient, 'from'>,
    importCompanyInfo: false,
    importCustomers: false,
    importSuppliers: false,
    importSalesInvoices: false,
    importSupplierInvoices: false,
    reconcileVouchers: false,
    ...overrides,
  }
}

describe('executeMigration: registration voucher links', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mLink.mockResolvedValue(LINK_COUNTS)
  })

  it('hands every inserted invoice, with its provider voucher ref, to the linker once and reports the counts', async () => {
    ;(fetchSalesInvoicesHydrated as Mock).mockResolvedValue({
      invoices: [
        salesDto({ invoiceNumber: '1001', sourceVoucher: { series: 'A', number: 329 } }),
        salesDto({ invoiceNumber: '1002' }),
        salesDto({ invoiceNumber: '1003', currencyCode: 'EUR' }),
      ],
      hydration: { ...HYDRATION, needed: 1, skippedForBudget: 1 },
      // 1003's detail form was never fetched: its ref is unknown, not absent.
      unhydratedIds: new Set(['1003']),
    })
    ;(fetchSupplierInvoicesHydrated as Mock).mockResolvedValue({
      invoices: [supplierDto({ invoiceNumber: 'L-77', sourceVoucher: { series: 'B', number: 5 } })],
      hydration: HYDRATION,
      unhydratedIds: new Set(),
    })

    const results = await executeMigration(
      baseOptions({ importSalesInvoices: true, importSupplierInvoices: true }),
    )

    expect(mLink).toHaveBeenCalledTimes(1)
    const call = mLink.mock.calls[0][0]
    expect(call.companyId).toBe('company-1')
    expect(call.invoices).toEqual([
      {
        invoiceId: 'invoices-1',
        kind: 'customer',
        sourceVoucher: { series: 'A', number: 329 },
        refNotFetched: false,
        invoiceDate: '2025-03-14',
        totalSek: 1000,
        currencyCode: 'SEK',
        invoiceNumber: '1001',
      },
      {
        invoiceId: 'invoices-2',
        kind: 'customer',
        sourceVoucher: null,
        refNotFetched: false,
        invoiceDate: '2025-03-14',
        totalSek: 1000,
        currencyCode: 'SEK',
        invoiceNumber: '1002',
      },
      {
        invoiceId: 'invoices-3',
        kind: 'customer',
        sourceVoucher: null,
        refNotFetched: true,
        invoiceDate: '2025-03-14',
        // The SEK total comes from the run's rate index; the linker gets the
        // currency so a mismatch can be explained as a rate difference.
        totalSek: expect.any(Number),
        currencyCode: 'EUR',
        invoiceNumber: '1003',
      },
      {
        invoiceId: 'supplier_invoices-1',
        kind: 'supplier',
        sourceVoucher: { series: 'B', number: 5 },
        refNotFetched: false,
        invoiceDate: '2025-05-02',
        totalSek: 2500,
        currencyCode: 'SEK',
        invoiceNumber: 'L-77',
      },
    ])

    expect(results.registrationLinks).toEqual({
      scanned: 2, linked: 1, noRef: 1, refNotFetched: 0, unresolved: 0, ambiguous: 0, amountMismatch: 0, alreadyLinked: 0,
    })
    expect(results.salesInvoices?.imported).toBe(3)
    expect(results.supplierInvoices?.imported).toBe(1)
    expect(results.stepErrors).toBeUndefined()
  })

  it('skips the linker entirely when no invoice was inserted', async () => {
    ;(fetchSalesInvoicesHydrated as Mock).mockResolvedValue({ invoices: [], hydration: HYDRATION, unhydratedIds: new Set() })

    const results = await executeMigration(baseOptions({ importSalesInvoices: true }))

    expect(mLink).not.toHaveBeenCalled()
    expect(results.registrationLinks).toBeUndefined()
  })

  it('records a linker failure as a step error and keeps the imported invoices', async () => {
    ;(fetchSalesInvoicesHydrated as Mock).mockResolvedValue({
      invoices: [salesDto({ invoiceNumber: '1001', sourceVoucher: { series: 'A', number: 1 } })],
      hydration: HYDRATION,
      unhydratedIds: new Set(),
    })
    mLink.mockRejectedValue(new Error('db down'))

    const results = await executeMigration(baseOptions({ importSalesInvoices: true }))

    expect(results.salesInvoices?.imported).toBe(1)
    expect(results.registrationLinks).toBeUndefined()
    expect(results.stepErrors).toEqual([
      expect.objectContaining({ step: 'registrationLinks' }),
    ])
  })
})
