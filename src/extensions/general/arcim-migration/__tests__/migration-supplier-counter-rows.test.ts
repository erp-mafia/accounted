import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

/**
 * The supplier invoice step writes a provider invoice's own rows, never the
 * voucher's payable leg, and imports an invoice whose rows do not add up to
 * it without rows, counted in the step result. Runs the real Visma mapper and
 * the real importer mapper over SupplierInvoiceApi-shaped payloads.
 */

vi.mock('@/lib/providers/resolve-consent', () => ({
  resolveConsent: vi.fn().mockResolvedValue({
    consent: { provider: 'visma' },
    accessToken: 'tok',
    providerCompanyId: 'visma-company',
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
    returned: rows.map((row, i) => ({ id: `${table}-${i + 1}`, org_number: row.org_number ?? null, name: row.name ?? null })),
    failedCount: 0,
    firstError: null,
  })),
}))

import { executeMigration } from '../lib/migration-orchestrator'
import { fetchSupplierInvoicesDirect, hydrateSupplierInvoices } from '@/lib/providers/provider-data-fetcher'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { mapVismaToSupplierInvoice } from '@/lib/providers/visma/mapper'

const HYDRATION = { needed: 0, hydrated: 0, failed: 0, skippedForBudget: 0 }

/** SupplierInvoiceApi: `Rows` are the registration voucher's rows. */
function visma(number: string, rows: [number, number, number][], total: number) {
  return mapVismaToSupplierInvoice({
    Id: `v-${number}`, InvoiceNumber: number, InvoiceDate: '2026-06-01', DueDate: '2026-06-30', CurrencyCode: 'SEK',
    TotalAmount: total, PaymentStatus: 3, SupplierName: 'Leverantör AB',
    Rows: rows.map(([account, debit, credit], i) => ({ LineNumber: i + 1, AccountNumber: account, DebetAmount: debit, CreditAmount: credit })),
  })
}

describe('executeMigration: supplier invoice rows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('stores the kontering without the 2440 row, and a row set that does not add up not at all', async () => {
    const mock = createQueuedMockSupabase()
    ;(fetchSupplierInvoicesDirect as Mock).mockResolvedValue([
      visma('500', [[6530, 1000, 0], [2641, 250, 0], [2440, 0, 1250]], 1250),
      // The cost row is missing: 250 kr of rows for a 1 250 kr invoice.
      visma('501', [[2641, 250, 0], [2440, 0, 1250]], 1250),
    ])
    ;(hydrateSupplierInvoices as Mock).mockImplementation(async (_p: unknown, _t: unknown, _c: unknown, given: unknown[]) => ({
      invoices: given, hydration: HYDRATION, unhydratedIds: new Set(),
    }))
    ;(fetchAllRows as Mock).mockImplementation(async (build: (range: { from: number; to: number }) => unknown) => {
      build({ from: 0, to: 999 })
      const lastTable = mock.supabase.from.mock.calls.at(-1)?.[0]
      return lastTable === 'suppliers' ? [{ id: 'sup-1', org_number: null, name: 'Leverantör AB' }] : []
    })

    const results = await executeMigration({
      consentId: 'consent-1', companyId: 'company-1', userId: 'user-1',
      supabase: mock.supabase as unknown as SupabaseClient,
      createHistoryClient: async () => ({ from: vi.fn() }) as unknown as Pick<SupabaseClient, 'from'>,
      importCompanyInfo: false, importCustomers: false, importSuppliers: false, importSalesInvoices: false,
      importSupplierInvoices: true, importAssets: false, reconcileVouchers: false, suggestParties: false,
    })

    const inserted = mock.findCalls('supplier_invoice_items', 'insert').flatMap(([rows]) => rows as Record<string, unknown>[])
    expect(inserted.map((row) => [row.supplier_invoice_id, row.account_number, row.line_total])).toEqual([
      ['supplier_invoices-1', '6530', 1000],
      ['supplier_invoices-1', '2641', 250],
    ])
    expect(results.supplierInvoices).toMatchObject({ imported: 2, rowsMismatch: 1 })
  })
})
