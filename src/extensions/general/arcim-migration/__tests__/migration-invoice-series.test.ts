import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { ProviderMigrationJob } from '@/lib/providers/migration-contract'

/**
 * Both provider migration paths continue the invoice series after the sales
 * invoices they imported (agent feedback seq 892914, 929266, 965009): the
 * counter stood at its start value, so the first invoice issued after a move
 * restarted the old system's series at 001. The counter logic itself is
 * tested in lib/invoices/__tests__/invoice-number-series.test.ts; this pins
 * which numbers each path hands it and that a failure never fails the import.
 */

const mocks = vi.hoisted(() => ({ advance: vi.fn(), warn: vi.fn() }))

vi.mock('@/lib/invoices/invoice-number-series', () => ({
  advanceInvoiceSeriesPastImported: mocks.advance,
}))
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: mocks.warn, error: vi.fn() }) }))

vi.mock('@/lib/providers/resolve-consent', () => ({
  resolveConsent: vi.fn().mockResolvedValue({
    consent: { provider: 'bokio' },
    accessToken: 'tok',
    providerCompanyId: 'provider-company',
  }),
}))
vi.mock('@/lib/providers/provider-data-fetcher', () => ({
  fetchCompanyInfoDirect: vi.fn(),
  fetchCustomersDirect: vi.fn(),
  fetchSuppliersDirect: vi.fn(),
  fetchSalesInvoicesDirect: vi.fn(),
  fetchSupplierInvoicesDirect: vi.fn(),
  fetchMigrationPage: vi.fn(),
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
import { advanceInvoiceSeriesForJob } from '../lib/migration-job-worker'
import { fetchSalesInvoicesDirect, hydrateSalesInvoices } from '@/lib/providers/provider-data-fetcher'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { SalesInvoiceDto } from '@/lib/providers/dto'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.advance.mockResolvedValue({ advanced: true, from: 1, to: 71 })
})

describe('job worker: end of the link phase', () => {
  const job = { id: 'job', company_id: 'company-1' } as ProviderMigrationJob

  /** The job's imported sales-invoice chunks, as the chunk read returns them. */
  function withReceipts(numbers: (string | null)[]) {
    const mock = createQueuedMockSupabase()
    ;(fetchAllRows as Mock).mockImplementation(async (build: (range: { from: number; to: number }) => unknown) => {
      build({ from: 0, to: 999 })
      return numbers.map((invoiceNumber, i) => ({ id: `chunk-${i}`, receipt: { link: { invoiceNumber } } }))
    })
    return mock
  }

  it('hands the counter every sales invoice number the job imported, once', async () => {
    const mock = withReceipts(['2350', '12', null])

    await advanceInvoiceSeriesForJob(mock.supabase as unknown as SupabaseClient, job, Date.now() + 60_000)

    expect(mocks.advance).toHaveBeenCalledTimes(1)
    expect(mocks.advance).toHaveBeenCalledWith(expect.anything(), 'company-1', ['2350', '12'])
    // Only this job's imported sales invoices.
    expect(mock.findCalls('migration_job_chunks', 'eq')).toEqual(
      expect.arrayContaining([['job_id', 'job'], ['resource', 'salesInvoices'], ['company_id', 'company-1']]),
    )
    expect(mock.findCall('migration_job_chunks', 'not')).toEqual(['target_id', 'is', null])
  })

  it('does nothing for a job without imported sales invoices', async () => {
    const mock = withReceipts([])
    await advanceInvoiceSeriesForJob(mock.supabase as unknown as SupabaseClient, job, Date.now() + 60_000)
    expect(mocks.advance).not.toHaveBeenCalled()
  })

  it('logs an outlier and changes nothing', async () => {
    mocks.advance.mockResolvedValueOnce({ advanced: false, reason: 'outlier', current: 1, highest: 133701141 })
    const mock = withReceipts(['1', '133701141'])

    await advanceInvoiceSeriesForJob(mock.supabase as unknown as SupabaseClient, job, Date.now() + 60_000)

    expect(mocks.warn).toHaveBeenCalledWith(
      'invoice series left unchanged: imported numbers look like an outlier',
      expect.objectContaining({ current: 1, highest: 133701141 }),
    )
  })

  it('logs a failed settings write and lets the job go on', async () => {
    mocks.advance.mockRejectedValueOnce(new Error('invoice series update failed: boom'))
    const mock = withReceipts(['70'])

    await expect(
      advanceInvoiceSeriesForJob(mock.supabase as unknown as SupabaseClient, job, Date.now() + 60_000),
    ).resolves.toBeUndefined()
    expect(mocks.warn).toHaveBeenCalledWith('invoice series not advanced after imported sales invoices', expect.anything())
  })
})

describe('wizard orchestrator: sales invoice step', () => {
  function salesDto(invoiceNumber: string): SalesInvoiceDto {
    return {
      id: `src-${invoiceNumber}`,
      invoiceNumber,
      issueDate: '2026-03-14',
      dueDate: '2026-04-13',
      currencyCode: 'SEK',
      status: 'sent',
      supplier: { name: '', identifications: [] },
      customer: { name: 'Kund AB', identifications: [] },
      lines: [],
      legalMonetaryTotal: { payableAmount: { value: 1250, currencyCode: 'SEK' } },
      taxTotal: { taxAmount: { value: 250, currencyCode: 'SEK' } },
      paymentStatus: { paid: false, balance: { value: 1250, currencyCode: 'SEK' } },
    } as SalesInvoiceDto
  }

  function run(invoices: SalesInvoiceDto[], existing: { id: string; invoice_number: string | null }[]) {
    const mock = createQueuedMockSupabase()
    ;(fetchSalesInvoicesDirect as Mock).mockResolvedValue(invoices)
    ;(hydrateSalesInvoices as Mock).mockImplementation(async (_p: unknown, _t: unknown, _c: unknown, given: unknown[]) => ({
      invoices: given,
      hydration: { needed: 0, hydrated: 0, failed: 0, skippedForBudget: 0 },
      unhydratedIds: new Set(),
    }))
    ;(fetchAllRows as Mock).mockImplementation(async (build: (range: { from: number; to: number }) => unknown) => {
      build({ from: 0, to: 999 })
      return mock.supabase.from.mock.calls.at(-1)?.[0] === 'invoices' ? existing : []
    })
    return executeMigration({
      consentId: 'consent-1',
      companyId: 'company-1',
      userId: 'user-1',
      supabase: mock.supabase as unknown as SupabaseClient,
      createHistoryClient: async () => ({ from: vi.fn() }) as unknown as Pick<SupabaseClient, 'from'>,
      importCompanyInfo: false,
      importCustomers: false,
      importSuppliers: false,
      importSalesInvoices: true,
      importSupplierInvoices: false,
      reconcileVouchers: false,
    })
  }

  it('counts the invoices imported now and those an earlier run imported', async () => {
    const results = await run([salesDto('68'), salesDto('69'), salesDto('70')], [
      { id: 'earlier', invoice_number: '70' },
      { id: 'own', invoice_number: '9000' },
    ])

    expect(results.salesInvoices).toMatchObject({ imported: 2 })
    expect(mocks.advance).toHaveBeenCalledTimes(1)
    const [, companyId, numbers] = mocks.advance.mock.calls[0]
    expect(companyId).toBe('company-1')
    // Listed by the provider and now in the register; an invoice the company
    // issued itself (9000) is not the provider's series and is not passed.
    expect([...numbers].sort()).toEqual(['68', '69', '70'])
  })

  it('never fails the step when the counter cannot be moved', async () => {
    mocks.advance.mockRejectedValueOnce(new Error('invoice series read failed: boom'))

    const results = await run([salesDto('1')], [])

    expect(results.salesInvoices).toMatchObject({ imported: 1 })
    expect(results.stepErrors).toBeUndefined()
    expect(mocks.warn).toHaveBeenCalledWith('invoice series not advanced after sales invoice import', expect.anything())
  })
})
