import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

/**
 * Locks how the invoice steps spend the hydration budget.
 *
 * A Björn Lundén company with 9 415 customer invoices was killed at the
 * function ceiling on every migration attempt (2026-09-07): the register was
 * listed, hydrated against a fixed budget and inserted inside one request
 * with no notion of the clock. Two rules keep a large register inside the
 * ceiling now:
 *
 *  - Only invoices this run can insert get a detail request. A number that is
 *    already in the database is a duplicate whatever its detail form says, so
 *    on a re-run the budget goes to the rows that are still missing instead
 *    of the same open invoices every time.
 *  - The budget is derived from the run's deadline: what is left, minus a
 *    reserve for inserting the rows, capped at the provider default. No
 *    deadline (self-hosted, tests) means the provider default.
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
  fetchSalesInvoicesDirect: vi.fn(),
  fetchSupplierInvoicesDirect: vi.fn(),
  hydrateSalesInvoices: vi.fn(),
  hydrateSupplierInvoices: vi.fn(),
}))

vi.mock('@/lib/invoices/bulk-reconcile-supplier-vouchers', () => ({
  reconcileSupplierInvoiceVouchers: vi.fn(),
}))

vi.mock('@/lib/invoices/link-migrated-registration-vouchers', () => ({
  linkMigratedRegistrationVouchers: vi.fn().mockResolvedValue({
    scanned: 0, linked: 0, noRef: 0, refNotFetched: 0, unresolved: 0, ambiguous: 0, amountMismatch: 0, alreadyLinked: 0, reports: [],
  }),
}))

vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: vi.fn().mockResolvedValue([]),
}))

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
  fetchSuppliersDirect,
  fetchSalesInvoicesDirect,
  fetchSupplierInvoicesDirect,
  hydrateSalesInvoices,
  hydrateSupplierInvoices,
} from '@/lib/providers/provider-data-fetcher'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { SalesInvoiceDto, SupplierDto, SupplierInvoiceDto } from '@/lib/providers/dto'

const mListSales = fetchSalesInvoicesDirect as Mock
const mHydrateSales = hydrateSalesInvoices as Mock
const mListSupplier = fetchSupplierInvoicesDirect as Mock
const mHydrateSupplier = hydrateSupplierInvoices as Mock
const mFetchAll = fetchAllRows as Mock

const HYDRATION = { needed: 0, hydrated: 0, failed: 0, skippedForBudget: 0 }

function party(name: string, orgNumber?: string) {
  return {
    name,
    identifications: orgNumber ? [{ schemeId: 'SE:ORGNR', id: orgNumber }] : [],
  }
}

function salesDto(invoiceNumber: string): SalesInvoiceDto {
  return {
    id: invoiceNumber,
    invoiceNumber,
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
  }
}

function supplierDto(invoiceNumber: string): SupplierInvoiceDto {
  return {
    id: invoiceNumber,
    invoiceNumber,
    issueDate: '2025-05-02',
    dueDate: '2025-06-01',
    currencyCode: 'SEK',
    status: 'booked',
    supplier: party('Leverantör AB', '5566778899'),
    buyer: party(''),
    lines: [],
    legalMonetaryTotal: { payableAmount: { value: 2500, currencyCode: 'SEK' } },
    taxTotal: { taxAmount: { value: 500, currencyCode: 'SEK' } },
    paymentStatus: { paid: false, balance: { value: 2500, currencyCode: 'SEK' } },
  }
}

const SUPPLIER: SupplierDto = {
  id: 'bl-sup-1',
  supplierNumber: '2001',
  active: true,
  party: party('Leverantör AB', '5566778899'),
}

/** Hydration hands back whatever it was given, unchanged. */
function passThrough(mock: Mock) {
  mock.mockImplementation(async (_p: unknown, _t: unknown, _c: unknown, given: unknown[]) => ({
    invoices: given,
    hydration: HYDRATION,
    unhydratedIds: new Set<string>(),
  }))
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
    importAssets: false,
    reconcileVouchers: false,
    ...overrides,
  }
}

describe('executeMigration: hydration budget and scope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mFetchAll.mockResolvedValue([])
    passThrough(mHydrateSales)
    passThrough(mHydrateSupplier)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('hydrates only the sales invoices that are not already in the database, and still counts the rest as duplicates', async () => {
    mListSales.mockResolvedValue([salesDto('1001'), salesDto('1002'), salesDto('1003')])
    // 1001 landed on an earlier run.
    mFetchAll.mockResolvedValue([{ invoice_number: '1001' }])

    const results = await executeMigration(baseOptions({ importSalesInvoices: true }))

    expect(mHydrateSales).toHaveBeenCalledTimes(1)
    const given = mHydrateSales.mock.calls[0][3] as SalesInvoiceDto[]
    expect(given.map((dto) => dto.invoiceNumber)).toEqual(['1002', '1003'])
    expect(results.salesInvoices).toMatchObject({
      total: 3,
      imported: 2,
      skipped: 1,
      skipReasons: { duplicate: 1 },
    })
  })

  it('leaves the budget to the provider default when the run has no deadline', async () => {
    mListSales.mockResolvedValue([salesDto('1001')])

    await executeMigration(baseOptions({ importSalesInvoices: true }))

    expect(mHydrateSales.mock.calls[0][4]).toBeUndefined()
  })

  it('derives the budget from the deadline: what is left minus the insert reserve, capped at 90 s', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T12:00:00Z'))
    mListSales.mockResolvedValue([salesDto('1001'), salesDto('1002')])

    // 100 s left, 2 rows to insert: 100 000 - (30 000 + 2 * 12) = 69 976.
    await executeMigration(
      baseOptions({ importSalesInvoices: true, deadlineMs: Date.now() + 100_000 }),
    )
    expect(mHydrateSales.mock.calls[0][4]).toBe(69_976)

    // Plenty of time left: the provider ceiling holds.
    mHydrateSales.mockClear()
    await executeMigration(
      baseOptions({ importSalesInvoices: true, deadlineMs: Date.now() + 600_000 }),
    )
    expect(mHydrateSales.mock.calls[0][4]).toBe(90_000)

    // The reserve alone exceeds what is left: no detail requests, the rows
    // are still inserted and completed later by the row-completion pass.
    mHydrateSales.mockClear()
    await executeMigration(
      baseOptions({ importSalesInvoices: true, deadlineMs: Date.now() + 20_000 }),
    )
    expect(mHydrateSales.mock.calls[0][4]).toBe(0)
  })

  it('skips the detail request for a supplier invoice whose (supplier, number) pair is already in the database', async () => {
    ;(fetchSuppliersDirect as Mock).mockResolvedValue([SUPPLIER])
    mListSupplier.mockResolvedValue([supplierDto('L-77'), supplierDto('L-78')])
    // fetchAllRows is called once for the existing suppliers (step 3) and
    // once for the existing supplier invoices (step 5); the mocked insert
    // gives the supplier the id `suppliers-1`.
    mFetchAll
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ supplier_invoice_number: 'L-77', supplier_id: 'suppliers-1' }])

    const results = await executeMigration(
      baseOptions({ importSuppliers: true, importSupplierInvoices: true }),
    )

    expect(mHydrateSupplier).toHaveBeenCalledTimes(1)
    const given = mHydrateSupplier.mock.calls[0][3] as SupplierInvoiceDto[]
    expect(given.map((dto) => dto.invoiceNumber)).toEqual(['L-78'])
    expect(results.supplierInvoices).toMatchObject({
      total: 2,
      imported: 1,
      skipped: 1,
      skipReasons: { duplicate: 1 },
    })
  })
})
