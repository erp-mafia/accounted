import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

/**
 * Locks how the register steps treat the stubs the invoice steps left behind.
 *
 * Every Björn Lundén migration before 2026-09-08 imported zero customers and
 * zero suppliers (the client dropped the register's bare-array answer), so
 * the invoice steps created org-less minimal parties for every counterparty.
 * Now that the registers arrive, a re-run must fold each register row onto
 * the stub that stood in for it (by name, filling in the org number), not
 * insert a second "Kund AB" beside it. Two rows that both carry org numbers
 * are never folded by name.
 */

vi.mock('@/lib/providers/resolve-consent', () => ({
  resolveConsent: vi.fn().mockResolvedValue({
    consent: { provider: 'bjornlunden' },
    accessToken: 'tok',
    providerCompanyId: 'user-key',
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

const mCustomers = fetchCustomersDirect as Mock
const mSuppliers = fetchSuppliersDirect as Mock
const mFetchAll = fetchAllRows as Mock
const mInsert = insertWithPerRowFallback as Mock

function orgParty(name: string, orgNumber: string) {
  return {
    name,
    identifications: [{ schemeId: 'SE:ORGNR', id: orgNumber }],
    legalEntity: { registrationName: name, companyId: orgNumber, companyIdSchemeId: 'SE:ORGNR' },
  }
}

function registerCustomer(name: string, orgNumber: string): CustomerDto {
  return { id: '1001', customerNumber: '1001', type: 'company', active: true, party: orgParty(name, orgNumber) }
}

function registerSupplier(name: string, orgNumber: string): SupplierDto {
  return { id: '2001', supplierNumber: '2001', active: true, party: orgParty(name, orgNumber) }
}

/** An org-less row the sales-invoice step created for a counterparty. */
function customerStub(id: string, name: string, orgNumber: string | null = null) {
  return {
    id,
    org_number: orgNumber,
    name,
    contact_person: null,
    invoice_email_cc_addresses: null,
    invoice_email_bcc_addresses: null,
  }
}

function options(supabase: unknown, overrides: Record<string, unknown> = {}) {
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
    importAssets: false,
    reconcileVouchers: false,
    ...overrides,
  }
}

describe('executeMigration: register rows fold onto the invoice stubs that stood in for them', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mFetchAll.mockResolvedValue([])
  })

  it('adopts an org-less customer stub with the same name and writes the org number onto it', async () => {
    const { supabase, findCall, enqueue } = createQueuedMockSupabase()
    // The enrichment update selects the row back; the queue answers it.
    enqueue({ data: { id: 'cust-stub' } })
    mFetchAll.mockResolvedValue([customerStub('cust-stub', 'Kund AB')])
    mCustomers.mockResolvedValue([registerCustomer('Kund AB', '5566778899')])

    const results = await executeMigration(options(supabase, { importCustomers: true }))

    expect(mInsert).not.toHaveBeenCalled()
    const update = findCall('customers', 'update')
    expect(update?.[0]).toMatchObject({ org_number: '5566778899' })
    expect(results.customers).toMatchObject({ total: 1, imported: 0, updated: 1 })
  })

  it('never folds two org-numbered customers by name', async () => {
    const { supabase, findCall } = createQueuedMockSupabase()
    mFetchAll.mockResolvedValue([customerStub('cust-other', 'Kund AB', '5511111111')])
    mCustomers.mockResolvedValue([registerCustomer('Kund AB', '5566778899')])

    const results = await executeMigration(options(supabase, { importCustomers: true }))

    expect(mInsert).toHaveBeenCalledTimes(1)
    expect(mInsert.mock.calls[0][1]).toBe('customers')
    expect(findCall('customers', 'update')).toBeUndefined()
    expect(results.customers).toMatchObject({ total: 1, imported: 1, updated: 0 })
  })

  it('adopts an org-less supplier stub the same way', async () => {
    const { supabase, findCall } = createQueuedMockSupabase()
    mFetchAll.mockResolvedValue([{ id: 'sup-stub', org_number: null, name: 'Lev AB' }])
    mSuppliers.mockResolvedValue([registerSupplier('Lev AB', '5566778899')])

    const results = await executeMigration(options(supabase, { importSuppliers: true }))

    expect(mInsert).not.toHaveBeenCalled()
    const update = findCall('suppliers', 'update')
    expect(update?.[0]).toEqual({ org_number: '5566778899' })
    expect(results.suppliers).toMatchObject({ total: 1, imported: 0, skipped: 1, skipReasons: { duplicate: 1 } })
  })
})
