import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

/**
 * Prod 2026-09-10 (company 5208b894, Visma): the customers/suppliers step
 * was re-run while a previous request was still inserting, and the second
 * request's existing-row snapshot predated the first request's rows: 987
 * duplicate customers (957 x2, 10 x4) and 9 duplicate suppliers. The
 * orchestrator now re-reads the rows that landed since the snapshot right
 * before each chunk insert and routes them through the same dedupe. The
 * durable fix is a unique index, which is a founder call.
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
import { fetchCustomersDirect, fetchSuppliersDirect } from '@/lib/providers/provider-data-fetcher'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { insertWithPerRowFallback } from '../lib/insert-fallback'
import type { CustomerDto, SupplierDto } from '@/lib/providers/dto'

function customerDto(id: string, name: string, orgNumber?: string): CustomerDto {
  return {
    id,
    customerNumber: id,
    type: 'company',
    party: { name, identifications: orgNumber ? [{ id: orgNumber, schemeId: 'SE:ORGNR' }] : [] },
    active: true,
  }
}

function supplierDto(id: string, name: string, orgNumber?: string): SupplierDto {
  return {
    id,
    supplierNumber: id,
    party: { name, identifications: orgNumber ? [{ id: orgNumber, schemeId: 'SE:ORGNR' }] : [] },
    active: true,
  }
}

function baseOptions(supabase: unknown, overrides: Record<string, unknown> = {}) {
  return {
    consentId: 'consent-1',
    companyId: 'company-1',
    userId: 'user-1',
    supabase: supabase as SupabaseClient,
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

const insertedTables = () => (insertWithPerRowFallback as Mock).mock.calls.map((c) => c[1] as string)

describe('executeMigration: chunk-level dedupe against rows that appeared since the snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(fetchAllRows as Mock).mockResolvedValue([])
  })

  it('skips a customer another request inserted between the snapshot and the chunk insert, and maps its id', async () => {
    ;(fetchCustomersDirect as Mock).mockResolvedValue([
      customerDto('c-1', 'Kund AB', '5566778899'),
      customerDto('c-2', 'Privatperson'),
    ])
    ;(fetchAllRows as Mock)
      // Step-start snapshot: nothing there yet.
      .mockResolvedValueOnce([])
      // Delta right before the first chunk: the concurrent request has
      // landed both rows in the meantime.
      .mockResolvedValueOnce([
        { id: 'cust-existing-1', org_number: '5566778899', name: 'Kund AB' },
        { id: 'cust-existing-2', org_number: null, name: 'Privatperson' },
      ])
    const { supabase } = createQueuedMockSupabase()

    const results = await executeMigration(baseOptions(supabase, { importCustomers: true }))

    expect(insertedTables()).not.toContain('customers')
    expect(results.customers).toMatchObject({
      total: 2,
      imported: 0,
      skipped: 2,
      skipReasons: { duplicate: 2 },
    })
  })

  it('reads the delta with a created_at lower bound, company-scoped', async () => {
    ;(fetchCustomersDirect as Mock).mockResolvedValue([customerDto('c-1', 'Kund AB', '5566778899')])
    const { supabase, findCall } = createQueuedMockSupabase()

    await executeMigration(baseOptions(supabase, { importCustomers: true }))

    // fetchAllRows is mocked: run the delta builder (second call) against the
    // recording client to see the predicate it would have sent.
    const deltaBuilder = (fetchAllRows as Mock).mock.calls[1][0] as (range: { from: number; to: number }) => unknown
    deltaBuilder({ from: 0, to: 999 })
    expect(findCall('customers', 'eq')).toEqual(['company_id', 'company-1'])
    const gt = findCall('customers', 'gt')
    expect(gt?.[0]).toBe('created_at')
    expect(typeof gt?.[1]).toBe('string')
    expect(Number.isNaN(Date.parse(gt?.[1] as string))).toBe(false)
  })

  it('still inserts rows nobody else wrote', async () => {
    ;(fetchCustomersDirect as Mock).mockResolvedValue([customerDto('c-1', 'Kund AB', '5566778899')])
    const { supabase } = createQueuedMockSupabase()

    const results = await executeMigration(baseOptions(supabase, { importCustomers: true }))

    expect(insertedTables()).toContain('customers')
    expect(results.customers).toMatchObject({ total: 1, imported: 1, skipped: 0 })
  })

  it('applies the same dedupe to suppliers, keyed by the normalised org number', async () => {
    ;(fetchSuppliersDirect as Mock).mockResolvedValue([supplierDto('s-1', 'Fora AB', '556677-8899')])
    ;(fetchAllRows as Mock)
      .mockResolvedValueOnce([])
      // The register stores the 10-digit key; the provider spells it with a hyphen.
      .mockResolvedValueOnce([{ id: 'sup-existing-1', org_number: '5566778899', name: 'Fora AB' }])
    const { supabase } = createQueuedMockSupabase()

    const results = await executeMigration(baseOptions(supabase, { importSuppliers: true }))

    expect(insertedTables()).not.toContain('suppliers')
    expect(results.suppliers).toMatchObject({
      total: 1,
      imported: 0,
      skipped: 1,
      skipReasons: { duplicate: 1 },
    })
  })
})
