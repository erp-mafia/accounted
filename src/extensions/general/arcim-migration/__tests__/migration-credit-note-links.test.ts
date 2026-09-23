import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

/**
 * Locks the credit-note pairing pass of the sales invoice step (crm#110):
 * a migrated kreditfaktura whose provider named the invoice it credits
 * (Bokio's invoiceRef) gets its credited_invoice_id after the inserts, from
 * this run's rows or from invoices an earlier run imported; one with no
 * reference, or a reference nothing here answers to, stays unpaired and is
 * counted. Nothing is ever paired by amount.
 */

vi.mock('@/lib/providers/resolve-consent', () => ({
  resolveConsent: vi.fn().mockResolvedValue({
    consent: { provider: 'bokio' },
    accessToken: 'tok',
    providerCompanyId: 'ea9ee4dd-fae3-4aec-a7db-6fc9cc1f8135',
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
import { fetchSalesInvoicesDirect, hydrateSalesInvoices, fetchSupplierInvoicesDirect, hydrateSupplierInvoices } from '@/lib/providers/provider-data-fetcher'
import { linkMigratedRegistrationVouchers } from '@/lib/invoices/link-migrated-registration-vouchers'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { SalesInvoiceDto, SupplierInvoiceDto } from '@/lib/providers/dto'

const HYDRATION = { needed: 0, hydrated: 0, failed: 0, skippedForBudget: 0 }

function party(name: string) {
  return { name, identifications: [] }
}

function salesDto(over: Partial<SalesInvoiceDto> & { invoiceNumber: string }): SalesInvoiceDto {
  return {
    id: `src-${over.invoiceNumber}`,
    issueDate: '2025-03-14',
    dueDate: '2025-04-13',
    currencyCode: 'SEK',
    status: 'sent',
    supplier: party(''),
    customer: party('Kund AB'),
    lines: [],
    legalMonetaryTotal: { payableAmount: { value: 1250, currencyCode: 'SEK' } },
    taxTotal: { taxAmount: { value: 250, currencyCode: 'SEK' } },
    paymentStatus: { paid: false, balance: { value: 1250, currencyCode: 'SEK' } },
    ...over,
  }
}

function creditNote(number: string, ref: SalesInvoiceDto['creditedInvoiceRef']): SalesInvoiceDto {
  return salesDto({ invoiceNumber: number, invoiceTypeCode: '381', status: 'credited', creditedInvoiceRef: ref })
}

function run(invoices: SalesInvoiceDto[], existing: { id: string; invoice_number: string | null }[] = []) {
  const mock = createQueuedMockSupabase()
  ;(fetchSalesInvoicesDirect as Mock).mockResolvedValue(invoices)
  ;(hydrateSalesInvoices as Mock).mockImplementation(async (_p: unknown, _t: unknown, _c: unknown, given: unknown[]) => ({
    invoices: given,
    hydration: HYDRATION,
    unhydratedIds: new Set(),
  }))
  // The orchestrator reads several registers through fetchAllRows; only the
  // invoices query answers with the rows an earlier run imported.
  ;(fetchAllRows as Mock).mockImplementation(async (build: (range: { from: number; to: number }) => unknown) => {
    build({ from: 0, to: 999 })
    const lastTable = mock.supabase.from.mock.calls.at(-1)?.[0]
    return lastTable === 'invoices' ? existing : []
  })
  const results = executeMigration({
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
  return { results, mock }
}

/** The (payload, id filter) of every credited_invoice_id update issued. */
function pairings(mock: ReturnType<typeof createQueuedMockSupabase>) {
  const updates = mock.calls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => call.table === 'invoices' && call.method === 'update')
  return updates.map(({ call, index }) => {
    const idFilter = mock.calls
      .slice(index + 1)
      .find((c) => c.table === 'invoices' && c.method === 'eq' && c.args[0] === 'id')
    return { payload: call.args[0], invoiceId: idFilter?.args[1] }
  })
}

describe('executeMigration: credit note pairing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('pairs a credit note with the invoice it credits when both are imported in this run', async () => {
    const { results, mock } = await (async () => {
      const r = run([
        salesDto({ invoiceNumber: 'IN-2024-001', status: 'credited' }),
        creditNote('CN-2024-001', { id: 'src-IN-2024-001', invoiceNumber: 'IN-2024-001' }),
      ])
      return { results: await r.results, mock: r.mock }
    })()

    expect(pairings(mock)).toEqual([{ payload: { credited_invoice_id: 'invoices-1' }, invoiceId: 'invoices-2' }])
    expect(results.salesInvoices).toMatchObject({ imported: 2, creditNotesLinked: 1, creditNotesUnlinked: 0 })
    expect(results.stepErrors).toBeUndefined()
  })

  it('resolves the credited invoice by number when an earlier run imported it', async () => {
    const r = run(
      [creditNote('CN-2024-009', { id: 'src-not-in-this-run', invoiceNumber: 'IN-2024-009' })],
      [{ id: 'invoices-from-last-week', invoice_number: 'IN-2024-009' }],
    )
    const results = await r.results

    expect(pairings(r.mock)).toEqual([{ payload: { credited_invoice_id: 'invoices-from-last-week' }, invoiceId: 'invoices-1' }])
    expect(results.salesInvoices).toMatchObject({ imported: 1, creditNotesLinked: 1, creditNotesUnlinked: 0 })
  })

  it('leaves a credit note unpaired, and counts it, when nothing answers to the reference', async () => {
    const r = run([creditNote('CN-2024-404', { id: 'src-nowhere', invoiceNumber: 'IN-2024-404' })])
    const results = await r.results

    expect(pairings(r.mock)).toEqual([])
    expect(results.salesInvoices).toMatchObject({ imported: 1, creditNotesLinked: 0, creditNotesUnlinked: 1 })
  })

  it('counts a credit note whose provider named no invoice as unpaired without guessing', async () => {
    // Visma and the arcim gateway send the type code and nothing else; the
    // amount matches the original exactly, and must not be used.
    const r = run([
      salesDto({ invoiceNumber: 'IN-2024-001', status: 'credited' }),
      creditNote('CN-2024-001', undefined),
    ])
    const results = await r.results

    expect(pairings(r.mock)).toEqual([])
    expect(results.salesInvoices).toMatchObject({ imported: 2, creditNotesLinked: 0, creditNotesUnlinked: 1 })
  })
})

/**
 * The supplier invoice step (#2838). A supplier credit note pairs by the
 * provider's own id of the invoice it credits, among this run's inserts only
 * (a supplier's invoice number is not unique in the company), and only with
 * an ordinary invoice of the same supplier and currency that is not smaller
 * than the credit. The registration link is handed what the voucher must
 * show: a credit note DEBITS 2440.
 */
describe('executeMigration: supplier credit note pairing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function supplierDto(over: Partial<SupplierInvoiceDto> & { invoiceNumber: string }, total = 5000, supplier = 'Leverantör AB'): SupplierInvoiceDto {
    return {
      id: `src-${over.invoiceNumber}`,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      currencyCode: 'SEK',
      status: 'booked',
      supplier: party(supplier),
      buyer: party(''),
      lines: [],
      legalMonetaryTotal: { payableAmount: { value: total, currencyCode: 'SEK' } },
      taxTotal: { taxAmount: { value: total * 0.2, currencyCode: 'SEK' } },
      paymentStatus: { paid: false, balance: { value: total, currencyCode: 'SEK' } },
      ...over,
    }
  }
  const supplierCredit = (number: string, refId: string | undefined, total = -1250, supplier = 'Leverantör AB') => supplierDto({
    invoiceNumber: number, invoiceTypeCode: '381', status: 'credited',
    creditedInvoiceRef: refId ? { id: refId, invoiceNumber: refId.replace('src-', '') } : undefined,
  }, total, supplier)

  async function runSuppliers(invoices: SupplierInvoiceDto[]) {
    const mock = createQueuedMockSupabase()
    ;(fetchSupplierInvoicesDirect as Mock).mockResolvedValue(invoices)
    ;(hydrateSupplierInvoices as Mock).mockImplementation(async (_p: unknown, _t: unknown, _c: unknown, given: unknown[]) => ({
      invoices: given, hydration: HYDRATION, unhydratedIds: new Set(),
    }))
    ;(fetchAllRows as Mock).mockImplementation(async (build: (range: { from: number; to: number }) => unknown) => {
      build({ from: 0, to: 999 })
      const lastTable = mock.supabase.from.mock.calls.at(-1)?.[0]
      return lastTable === 'suppliers'
        ? [{ id: 'sup-1', org_number: null, name: 'Leverantör AB' }, { id: 'sup-2', org_number: null, name: 'Annan AB' }]
        : []
    })
    const results = await executeMigration({
      consentId: 'consent-1', companyId: 'company-1', userId: 'user-1',
      supabase: mock.supabase as unknown as SupabaseClient,
      createHistoryClient: async () => ({ from: vi.fn() }) as unknown as Pick<SupabaseClient, 'from'>,
      importCompanyInfo: false, importCustomers: false, importSuppliers: false, importSalesInvoices: false,
      importSupplierInvoices: true, importAssets: false, reconcileVouchers: false, suggestParties: false,
    })
    const updates = mock.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.table === 'supplier_invoices' && call.method === 'update')
      .map(({ call, index }) => ({
        payload: call.args[0],
        invoiceId: mock.calls.slice(index + 1).find((c) => c.table === 'supplier_invoices' && c.method === 'eq' && c.args[0] === 'id')?.args[1],
      }))
    return { results, updates }
  }

  it('pairs a supplier credit note with the invoice the provider named, and links on the negated total', async () => {
    const { results, updates } = await runSuppliers([supplierCredit('312', 'src-311'), supplierDto({ invoiceNumber: '311' })])
    expect(updates).toEqual([{ payload: { credited_invoice_id: 'supplier_invoices-2' }, invoiceId: 'supplier_invoices-1' }])
    expect(results.supplierInvoices).toMatchObject({ imported: 2, creditNotesLinked: 1, creditNotesUnlinked: 0 })
    const inputs = (linkMigratedRegistrationVouchers as Mock).mock.calls[0][0].invoices as { invoiceNumber: string; totalSek: number }[]
    expect(inputs.map((i) => [i.invoiceNumber, i.totalSek])).toEqual([['312', -1250], ['311', 5000]])
  })

  it.each([
    ['names nothing', [supplierCredit('312', undefined), supplierDto({ invoiceNumber: '311' })]],
    ['names an invoice outside this run', [supplierCredit('312', 'src-900')]],
    ['names another supplier\'s invoice', [supplierCredit('312', 'src-311'), supplierDto({ invoiceNumber: '311' }, 5000, 'Annan AB')]],
    ['names another credit note', [supplierCredit('312', 'src-311'), supplierCredit('311', undefined, -5000)]],
    ['names an invoice smaller than the credit', [supplierCredit('312', 'src-311'), supplierDto({ invoiceNumber: '311' }, 1000)]],
  ])('leaves it unpaired, and counts it, when the credit note %s', async (_label, invoices) => {
    const { results, updates } = await runSuppliers(invoices)
    expect(updates).toEqual([])
    expect(results.supplierInvoices?.creditNotesLinked).toBe(0)
    expect(results.supplierInvoices?.creditNotesUnlinked).toBeGreaterThanOrEqual(1)
  })
})
