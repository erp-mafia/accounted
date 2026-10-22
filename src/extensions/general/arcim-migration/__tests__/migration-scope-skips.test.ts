import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

/**
 * #2469: the orchestrator scopes the listed register before any detail
 * fetch, declining paid invoices outside the imported fiscal years, counts
 * what it declined as a named skip, and runs the party scan only when the
 * request says so (the wizard sends one request per step and finishes on
 * the last). The invoice steps list first and hydrate only what this run
 * can insert, so the scope is asserted on what the hydration pass receives.
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

vi.mock('@/lib/parties/suggest', () => ({
  suggestPartiesForCompany: vi.fn().mockResolvedValue({ created: 0, attached: 0, skipped: 0 }),
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
import { resolveConsent } from '@/lib/providers/resolve-consent'
import {
  fetchSalesInvoicesDirect,
  fetchSupplierInvoicesDirect,
  hydrateSalesInvoices,
  hydrateSupplierInvoices,
} from '@/lib/providers/provider-data-fetcher'
import { suggestPartiesForCompany } from '@/lib/parties/suggest'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { insertWithPerRowFallback } from '../lib/insert-fallback'
import type { SalesInvoiceDto, SupplierInvoiceDto } from '@/lib/providers/dto'

function vismaError(statusCode: number): Error {
  const e = new Error(`Visma API error: ${statusCode}`) as Error & { statusCode: number }
  e.statusCode = statusCode
  return e
}

const mListSales = fetchSalesInvoicesDirect as Mock
const mListSupplier = fetchSupplierInvoicesDirect as Mock
const mHydrateSales = hydrateSalesInvoices as Mock
const mHydrateSupplier = hydrateSupplierInvoices as Mock

const HYDRATION = { needed: 0, hydrated: 0, failed: 0, skippedForBudget: 0 }

/** Hydration hands back whatever it was given, unchanged. */
function passThrough(mock: Mock) {
  mock.mockImplementation(async (_p: unknown, _t: unknown, _c: unknown, given: unknown[]) => ({
    invoices: given,
    hydration: HYDRATION,
    unhydratedIds: new Set<string>(),
  }))
}

/** Invoice numbers the hydration pass was handed, in order. */
function hydratedNumbers(mock: Mock): string[] {
  return (mock.mock.calls[0][3] as { invoiceNumber: string }[]).map((dto) => dto.invoiceNumber)
}

function party(name: string) {
  return { name, identifications: [] }
}

function salesDto(invoiceNumber: string, issueDate: string, paid: boolean): SalesInvoiceDto {
  return {
    id: invoiceNumber,
    invoiceNumber,
    issueDate,
    dueDate: issueDate,
    currencyCode: 'SEK',
    status: 'sent',
    supplier: party(''),
    customer: party('Kund AB'),
    lines: [],
    legalMonetaryTotal: { payableAmount: { value: 1000, currencyCode: 'SEK' } },
    taxTotal: { taxAmount: { value: 200, currencyCode: 'SEK' } },
    paymentStatus: { paid, balance: { value: paid ? 0 : 1000, currencyCode: 'SEK' } },
  }
}

function supplierDto(invoiceNumber: string, issueDate: string, paid: boolean): SupplierInvoiceDto {
  return {
    id: invoiceNumber,
    invoiceNumber,
    issueDate,
    dueDate: issueDate,
    currencyCode: 'SEK',
    status: 'booked',
    supplier: party('Leverantör AB'),
    buyer: party(''),
    lines: [],
    legalMonetaryTotal: { payableAmount: { value: 2500, currencyCode: 'SEK' } },
    taxTotal: { taxAmount: { value: 500, currencyCode: 'SEK' } },
    paymentStatus: { paid, balance: { value: paid ? 0 : 2500, currencyCode: 'SEK' } },
  }
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

const SCOPE = { start: '2026-01-01', end: '2026-12-31' }

describe('executeMigration: fiscal-year scope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(fetchAllRows as Mock).mockResolvedValue([])
    passThrough(mHydrateSales)
    passThrough(mHydrateSupplier)
  })

  it('scopes the listed register before hydration: paid outside the years declined, unpaid kept from any year', async () => {
    mListSales.mockResolvedValue([
      salesDto('1', '2026-03-01', true),
      salesDto('2', '2025-03-01', true),
      salesDto('3', '2025-03-01', false),
    ])
    mListSupplier.mockResolvedValue([
      supplierDto('L1', '2024-12-31', true),
      supplierDto('L2', '2024-12-31', false),
    ])

    const results = await executeMigration(baseOptions({ importSalesInvoices: true, importSupplierInvoices: true, fiscalYearScope: SCOPE }))

    expect(hydratedNumbers(mHydrateSales)).toEqual(['1', '3'])
    expect(hydratedNumbers(mHydrateSupplier)).toEqual(['L2'])
    expect(results.salesInvoices).toMatchObject({ total: 3, imported: 2, skipped: 1, skipReasons: { outsideFiscalYears: 1 } })
    expect(results.supplierInvoices).toMatchObject({ total: 2, imported: 1, skipped: 1, skipReasons: { outsideFiscalYears: 1 } })
  })

  it('keeps everything when the request carries no scope', async () => {
    mListSales.mockResolvedValue([salesDto('2', '2019-03-01', true)])

    const results = await executeMigration(baseOptions({ importSalesInvoices: true }))

    expect(hydratedNumbers(mHydrateSales)).toEqual(['2'])
    expect(results.salesInvoices).toMatchObject({ total: 1, imported: 1, skipped: 0 })
  })

  it('counts what the scope declined as a named skip and keeps the register total honest', async () => {
    mListSales.mockResolvedValue([
      salesDto('1001', '2026-03-01', false),
      salesDto('900', '2024-01-10', true),
      salesDto('901', '2025-06-10', true),
    ])

    const results = await executeMigration(baseOptions({ importSalesInvoices: true, fiscalYearScope: SCOPE }))

    expect(hydratedNumbers(mHydrateSales)).toEqual(['1001'])
    expect(results.salesInvoices).toMatchObject({
      total: 3,
      imported: 1,
      skipped: 2,
      skipReasons: { outsideFiscalYears: 2 },
    })
  })

  it('reports no outsideFiscalYears skip when the scope declined nothing', async () => {
    mListSales.mockResolvedValue([salesDto('1001', '2026-03-01', false)])

    const results = await executeMigration(baseOptions({ importSalesInvoices: true, fiscalYearScope: SCOPE }))

    expect(results.salesInvoices).toMatchObject({ total: 1, imported: 1, skipped: 0 })
    expect(results.salesInvoices?.skipReasons?.outsideFiscalYears).toBeUndefined()
  })
})

describe('executeMigration: per-step requests (#2469)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(fetchAllRows as Mock).mockResolvedValue([])
    passThrough(mHydrateSales)
    passThrough(mHydrateSupplier)
  })

  it('resolves invoices against the customers an earlier request imported instead of re-creating them', async () => {
    // Request N-1 imported "Kund AB"; this request runs only the sales
    // invoice step, so the customer step's in-memory maps are empty.
    const kund = { ...salesDto('1001', '2026-03-01', false), customer: { name: 'Kund AB', identifications: [{ schemeId: 'SE:ORGNR', id: '5560125790' }] } }
    mListSales.mockResolvedValue([kund])
    // First register read in the step is the customer register, then invoices.
    ;(fetchAllRows as Mock)
      .mockResolvedValueOnce([{ id: 'cust-existing', org_number: '5560125790', name: 'Kund AB' }])
      .mockResolvedValue([])

    const results = await executeMigration(baseOptions({ importSalesInvoices: true }))

    const tables = (insertWithPerRowFallback as Mock).mock.calls.map((c) => c[1])
    expect(tables).not.toContain('customers')
    const invoiceRows = (insertWithPerRowFallback as Mock).mock.calls.find((c) => c[1] === 'invoices')![2]
    expect(invoiceRows[0].customer_id).toBe('cust-existing')
    expect(results.salesInvoices).toMatchObject({ imported: 1 })
  })

  it('resolves supplier invoices against the suppliers an earlier request imported', async () => {
    const lev = { ...supplierDto('L-1', '2026-03-01', false), supplier: { name: 'Leverantör AB', identifications: [{ schemeId: 'SE:ORGNR', id: '5566778899' }] } }
    mListSupplier.mockResolvedValue([lev])
    ;(fetchAllRows as Mock)
      .mockResolvedValueOnce([{ id: 'supp-existing', org_number: '5566778899', name: 'Leverantör AB' }])
      .mockResolvedValue([])

    await executeMigration(baseOptions({ importSupplierInvoices: true }))

    const tables = (insertWithPerRowFallback as Mock).mock.calls.map((c) => c[1])
    expect(tables).not.toContain('suppliers')
    const rows = (insertWithPerRowFallback as Mock).mock.calls.find((c) => c[1] === 'supplier_invoices')![2]
    expect(rows[0].supplier_id).toBe('supp-existing')
  })

  it('keeps the Fortnox löpnummer on an imported supplier invoice and knows a stored one by it (crm#1157)', async () => {
    vi.mocked(resolveConsent).mockResolvedValueOnce({
      consent: { provider: 'fortnox' }, accessToken: 'tok', providerCompanyId: null,
    } as unknown as Awaited<ReturnType<typeof resolveConsent>>)
    const lev = { name: 'Leverantör AB', identifications: [{ schemeId: 'SE:ORGNR', id: '5566778899' }] }
    mListSupplier.mockResolvedValue([
      // Stored with its löpnummer beside a supplier number typed by hand.
      { ...supplierDto('21879926', '2026-09-25', false), id: '367', supplier: lev },
      // Stored before fortnox_number: its supplier number is the löpnummer.
      { ...supplierDto('368', '2026-09-26', false), id: '368', supplier: lev },
      { ...supplierDto('369', '2026-09-27', false), id: '369', supplier: lev },
    ])
    ;(fetchAllRows as Mock)
      .mockResolvedValueOnce([{ id: 'supp-existing', org_number: '5566778899', name: 'Leverantör AB' }])
      .mockResolvedValueOnce([
        { supplier_invoice_number: 'typed by hand', supplier_id: 'supp-existing', invoice_date: '2026-09-25', total: 2500, fortnox_number: '367' },
        { supplier_invoice_number: '368', supplier_id: 'supp-existing', invoice_date: '2026-09-26', total: 2500, fortnox_number: null },
      ])
      .mockResolvedValue([])

    const results = await executeMigration(baseOptions({ importSupplierInvoices: true }))

    expect(hydratedNumbers(mHydrateSupplier)).toEqual(['369'])
    const rows = (insertWithPerRowFallback as Mock).mock.calls.find((c) => c[1] === 'supplier_invoices')![2]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ supplier_id: 'supp-existing', supplier_invoice_number: '369', fortnox_number: '369' })
    expect(results.supplierInvoices).toMatchObject({ total: 3, imported: 1, skipped: 2, skipReasons: { duplicate: 2 } })
  })

  it('stores a Fortnox supplier number the supplier reuses on another date as the payment reference, and refuses what cannot be stored (crm#1039, crm#1157)', async () => {
    vi.mocked(resolveConsent).mockResolvedValueOnce({
      consent: { provider: 'fortnox' }, accessToken: 'tok', providerCompanyId: null,
    } as unknown as Awaited<ReturnType<typeof resolveConsent>>)
    const lev = { name: 'Leverantör AB', identifications: [{ schemeId: 'SE:ORGNR', id: '5566778899' }] }
    const reused = (id: string, issueDate: string, ocrNumber?: string) =>
      ({ ...supplierDto('AVT-1', issueDate, false), id, supplier: lev, ...(ocrNumber ? { ocrNumber } : {}) })
    mListSupplier.mockResolvedValue([
      reused('11', '2026-10-01'),
      // The date of the invoice already stored with the number.
      reused('12', '2026-09-01'),
      // Another date, but its own payment reference already: both cannot be kept.
      reused('13', '2026-11-01', '4455667788'),
      // The date of the one this run stores as a payment reference.
      reused('14', '2026-10-01'),
    ])
    ;(fetchAllRows as Mock)
      .mockResolvedValueOnce([{ id: 'supp-existing', org_number: '5566778899', name: 'Leverantör AB' }])
      .mockResolvedValueOnce([
        { supplier_invoice_number: 'AVT-1', supplier_id: 'supp-existing', invoice_date: '2026-09-01', total: 2500,
          fortnox_number: '10', status: 'registered', payment_reference: null },
      ])
      .mockResolvedValue([])

    const results = await executeMigration(baseOptions({ importSupplierInvoices: true }))

    expect(hydratedNumbers(mHydrateSupplier)).toEqual(['AVT-1', 'AVT-1', 'AVT-1', 'AVT-1'])
    const rows = (insertWithPerRowFallback as Mock).mock.calls.find((c) => c[1] === 'supplier_invoices')![2]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      supplier_id: 'supp-existing', supplier_invoice_number: null, payment_reference: 'AVT-1', fortnox_number: '11', arrival_number: 1,
    })
    expect(results.supplierInvoices).toMatchObject({ total: 4, imported: 1, skipped: 3, skipReasons: { failed: 3 } })
    expect(results.supplierInvoices?.errorSample).toContain('samma nummer och datum')
  })

  it('stores no löpnummer for another provider', async () => {
    mListSupplier.mockResolvedValue([supplierDto('L-9', '2026-03-01', false)])

    await executeMigration(baseOptions({ importSupplierInvoices: true }))

    const rows = (insertWithPerRowFallback as Mock).mock.calls.find((c) => c[1] === 'supplier_invoices')![2]
    expect(rows[0]).not.toHaveProperty('fortnox_number')
  })

  it('reads an opaque 403 as one closed register when an earlier request proved the grant', async () => {
    mListSupplier.mockRejectedValue(vismaError(403))

    const results = await executeMigration(baseOptions({ importSupplierInvoices: true, grantProven: true }))

    expect(results.stepErrors).toHaveLength(1)
    expect(results.stepErrors![0].code).toBe('PROVIDER_RESOURCE_FORBIDDEN')
  })

  it('still treats a 403 on the first call of a migration as a dead grant', async () => {
    mListSupplier.mockRejectedValue(vismaError(403))

    await expect(
      executeMigration(baseOptions({ importSupplierInvoices: true })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('executeMigration: suggestParties', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs the party scan by default and skips it when the request says so', async () => {
    await executeMigration(baseOptions())
    expect(suggestPartiesForCompany).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    await executeMigration(baseOptions({ suggestParties: false }))
    expect(suggestPartiesForCompany).not.toHaveBeenCalled()
  })
})

/**
 * Bokio returns supplier invoices older than the register its API exposes
 * with totalAmount 0 and no line items. Imported, they became 0 kr payables
 * whose zero balance read as "betald" (292 of 661 rows for the company that
 * reported it on 2026-09-14). An amount-less record is not a 0 kr invoice:
 * it is declined, and the count is reported rather than left unexplained.
 */
describe('executeMigration: supplier invoices the provider sent without an amount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(fetchAllRows as Mock).mockResolvedValue([])
    passThrough(mHydrateSupplier)
  })

  function amountless(invoiceNumber: string): SupplierInvoiceDto {
    const dto = supplierDto(invoiceNumber, '2019-06-01', false)
    return {
      ...dto,
      lines: [],
      legalMonetaryTotal: { payableAmount: { value: 0, currencyCode: 'SEK' } },
      taxTotal: undefined,
      paymentStatus: { paid: false, balance: { value: 0, currencyCode: 'SEK' }, source: 'balance' },
    }
  }

  it('skips them under their own reason and imports the rest', async () => {
    mListSupplier.mockResolvedValue([amountless('L-OLD-1'), amountless('L-OLD-2'), supplierDto('L-1', '2026-03-01', false)])

    const results = await executeMigration(baseOptions({ importSupplierInvoices: true }))

    expect(results.supplierInvoices).toMatchObject({
      total: 3,
      imported: 1,
      skipped: 2,
      skipReasons: { zeroTotal: 2 },
    })
    const rows = (insertWithPerRowFallback as Mock).mock.calls.find((c) => c[1] === 'supplier_invoices')![2]
    expect(rows).toHaveLength(1)
    expect(rows[0].supplier_invoice_number).toBe('L-1')
  })

  it('keeps an amount-less invoice that still carries line items: those say what it is', async () => {
    const withLines: SupplierInvoiceDto = {
      ...amountless('L-OLD-3'),
      lines: [{ id: '1', description: 'Tjänst', lineExtensionAmount: { value: 800, currencyCode: 'SEK' } }],
    }
    mListSupplier.mockResolvedValue([withLines])

    const results = await executeMigration(baseOptions({ importSupplierInvoices: true }))

    expect(results.supplierInvoices).toMatchObject({ imported: 1, skipped: 0 })
  })
})
