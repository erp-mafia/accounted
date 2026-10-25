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

/** A register record that says how to reach the customer (crm#1436). */
function contactParty(name: string, orgNumber: string) {
  return {
    ...orgParty(name, orgNumber),
    postalAddress: { streetName: 'Storgatan 1', postalZone: '111 22', cityName: 'Stockholm', countryCode: 'SE' },
    contact: { email: 'faktura@kund.example', telephone: '08-123 45 67' },
  }
}

/** A stub as the sales-invoice step leaves it: no way to reach the customer. */
function bareStub(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    ...customerStub(id, name),
    customer_type: 'swedish_business',
    email: null, phone: null, address_line1: null, address_line2: null, postal_code: null, city: null,
    country: 'SE', vat_number: null, notes: null,
    ...overrides,
  }
}

describe('executeMigration: a matched card gets the register\'s phone, e-mail and address (crm#1436)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mFetchAll.mockResolvedValue([])
  })

  it('fills them on the invoice stub the register customer folds onto', async () => {
    const { supabase, calls, findCall, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'cust-stub' } })
    mFetchAll.mockResolvedValue([bareStub('cust-stub', 'Kund AB')])
    mCustomers.mockResolvedValue([{ ...registerCustomer('Kund AB', '5566778899'), party: contactParty('Kund AB', '5566778899') }])

    const results = await executeMigration(options(supabase, { importCustomers: true }))

    expect(mInsert).not.toHaveBeenCalled()
    expect(findCall('customers', 'update')?.[0]).toMatchObject({
      org_number: '5566778899', phone: '08-123 45 67', email: 'faktura@kund.example',
      address_line1: 'Storgatan 1', postal_code: '111 22', city: 'Stockholm',
    })
    // Written only while the card still has none of them.
    const guards = calls.filter((c) => c.table === 'customers' && c.method === 'is').map((c) => c.args[0])
    expect(guards).toEqual(expect.arrayContaining(['org_number', 'phone', 'email', 'address_line1', 'city']))
    expect(results.customers).toMatchObject({ total: 1, imported: 0, updated: 1 })
  })

  it('never overwrites a phone number the user typed on the card', async () => {
    const { supabase, findCall, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'cust-typed' } })
    mFetchAll.mockResolvedValue([bareStub('cust-typed', 'Kund AB', { org_number: '5566778899', phone: '070-999 99 99' })])
    mCustomers.mockResolvedValue([{ ...registerCustomer('Kund AB', '5566778899'), party: contactParty('Kund AB', '5566778899') }])

    await executeMigration(options(supabase, { importCustomers: true }))

    const update = findCall('customers', 'update')?.[0] as Record<string, unknown>
    expect(update.phone).toBeUndefined()
    expect(update).toMatchObject({ email: 'faktura@kund.example', city: 'Stockholm' })
  })

  it('counts a card the user filled in meanwhile as left alone, not as a failure', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    mFetchAll.mockResolvedValue([bareStub('cust-stub', 'Kund AB')])
    mCustomers.mockResolvedValue([{ ...registerCustomer('Kund AB', '5566778899'), party: contactParty('Kund AB', '5566778899') }])

    const results = await executeMigration(options(supabase, { importCustomers: true }))

    expect(results.customers).toMatchObject({ updated: 0, skipped: 1, skipReasons: { duplicate: 1 } })
  })

  it('still writes a new card with its phone, e-mail and address', async () => {
    const { supabase, findCall } = createQueuedMockSupabase()
    mCustomers.mockResolvedValue([{ ...registerCustomer('Ny Kund AB', '5566778899'), party: contactParty('Ny Kund AB', '5566778899') }])

    const results = await executeMigration(options(supabase, { importCustomers: true }))

    expect(mInsert.mock.calls[0][2][0]).toMatchObject({
      name: 'Ny Kund AB', phone: '08-123 45 67', email: 'faktura@kund.example', address_line1: 'Storgatan 1', city: 'Stockholm',
    })
    expect(findCall('customers', 'update')).toBeUndefined()
    expect(results.customers).toMatchObject({ imported: 1, updated: 0 })
  })

  it('fills the supplier stub the register supplier folds onto, after its org number', async () => {
    const { supabase, findCalls } = createQueuedMockSupabase()
    mFetchAll.mockResolvedValue([{
      id: 'sup-stub', org_number: null, name: 'Lev AB', email: null, phone: null, address_line1: null, address_line2: null,
      postal_code: null, city: null, country: 'SE', vat_number: null, bankgiro: null, plusgiro: null, bank_account: null, notes: null,
    }])
    mSuppliers.mockResolvedValue([{ ...registerSupplier('Lev AB', '5566778899'), party: contactParty('Lev AB', '5566778899'), bankGiro: '123-4567' }])

    await executeMigration(options(supabase, { importSuppliers: true }))

    const updates = findCalls('suppliers', 'update').map((args) => args[0])
    expect(updates[0]).toEqual({ org_number: '5566778899' })
    expect(updates[1]).toMatchObject({ phone: '08-123 45 67', email: 'faktura@kund.example', city: 'Stockholm', bankgiro: '123-4567' })
    // The org number is the step's own write, never a second time here.
    expect((updates[1] as Record<string, unknown>).org_number).toBeUndefined()
  })
})
