import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

/**
 * #2469: the orchestrator hands the fetchers a predicate that declines paid
 * invoices outside the imported fiscal years, counts what they declined as
 * a named skip, and runs the party scan only when the request says so (the
 * wizard sends one request per step and finishes on the last).
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
import {
  fetchSalesInvoicesHydrated,
  fetchSupplierInvoicesHydrated,
} from '@/lib/providers/provider-data-fetcher'
import { suggestPartiesForCompany } from '@/lib/parties/suggest'
import type { SalesInvoiceDto, SupplierInvoiceDto } from '@/lib/providers/dto'

const HYDRATION = { needed: 0, hydrated: 0, failed: 0, skippedForBudget: 0 }

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
  })

  it('hands the fetchers a predicate that mirrors the scope, unpaid kept from any year', async () => {
    ;(fetchSalesInvoicesHydrated as Mock).mockResolvedValue({ invoices: [], hydration: HYDRATION, unhydratedIds: new Set(), excluded: [] })
    ;(fetchSupplierInvoicesHydrated as Mock).mockResolvedValue({ invoices: [], hydration: HYDRATION, unhydratedIds: new Set(), excluded: [] })

    await executeMigration(baseOptions({ importSalesInvoices: true, importSupplierInvoices: true, fiscalYearScope: SCOPE }))

    const salesSelect = (fetchSalesInvoicesHydrated as Mock).mock.calls[0][4] as (dto: SalesInvoiceDto) => boolean
    expect(salesSelect(salesDto('1', '2026-03-01', true))).toBe(true)
    expect(salesSelect(salesDto('2', '2025-03-01', true))).toBe(false)
    expect(salesSelect(salesDto('3', '2025-03-01', false))).toBe(true)

    const supplierSelect = (fetchSupplierInvoicesHydrated as Mock).mock.calls[0][4] as (dto: SupplierInvoiceDto) => boolean
    expect(supplierSelect(supplierDto('L1', '2024-12-31', true))).toBe(false)
    expect(supplierSelect(supplierDto('L2', '2024-12-31', false))).toBe(true)
  })

  it('keeps everything when the request carries no scope', async () => {
    ;(fetchSalesInvoicesHydrated as Mock).mockResolvedValue({ invoices: [], hydration: HYDRATION, unhydratedIds: new Set(), excluded: [] })

    await executeMigration(baseOptions({ importSalesInvoices: true }))

    const salesSelect = (fetchSalesInvoicesHydrated as Mock).mock.calls[0][4] as (dto: SalesInvoiceDto) => boolean
    expect(salesSelect(salesDto('2', '2019-03-01', true))).toBe(true)
  })

  it('counts what the fetcher declined as a named skip and keeps the register total honest', async () => {
    ;(fetchSalesInvoicesHydrated as Mock).mockResolvedValue({
      invoices: [salesDto('1001', '2026-03-01', false)],
      hydration: HYDRATION,
      unhydratedIds: new Set(),
      excluded: [salesDto('900', '2024-01-10', true), salesDto('901', '2025-06-10', true)],
    })

    const results = await executeMigration(baseOptions({ importSalesInvoices: true, fiscalYearScope: SCOPE }))

    expect(results.salesInvoices).toMatchObject({
      total: 3,
      imported: 1,
      skipped: 2,
      skipReasons: { outsideFiscalYears: 2 },
    })
  })

  it('still reads a fetcher that predates the excluded field', async () => {
    ;(fetchSalesInvoicesHydrated as Mock).mockResolvedValue({
      invoices: [salesDto('1001', '2026-03-01', false)],
      hydration: HYDRATION,
      unhydratedIds: new Set(),
    })

    const results = await executeMigration(baseOptions({ importSalesInvoices: true, fiscalYearScope: SCOPE }))

    expect(results.salesInvoices).toMatchObject({ total: 1, imported: 1, skipped: 0 })
    expect(results.salesInvoices?.skipReasons?.outsideFiscalYears).toBeUndefined()
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
