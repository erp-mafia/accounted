import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

/**
 * The legacy /migrate sales-invoice step creates a minimal customer for an
 * invoice whose customer it cannot find. The invoice does not say private or
 * company, so a personnummer used to land in plaintext in org_number on a
 * swedish_business stub. It now makes a privatperson stub with the number
 * encrypted in personal_number; an organisationsnummer stays on a business.
 */

vi.mock('@/lib/providers/resolve-consent', () => ({
  resolveConsent: vi.fn().mockResolvedValue({
    consent: { provider: 'fortnox' },
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
import { fetchSalesInvoicesDirect, hydrateSalesInvoices } from '@/lib/providers/provider-data-fetcher'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { insertWithPerRowFallback } from '../lib/insert-fallback'
import { decryptPersonnummer } from '@/lib/salary/personnummer'
import type { PartyDto, SalesInvoiceDto } from '@/lib/providers/dto'

const mListSales = fetchSalesInvoicesDirect as Mock
const mHydrateSales = hydrateSalesInvoices as Mock
const mInsert = insertWithPerRowFallback as Mock

function customerParty(name: string, number: string): PartyDto {
  return {
    name,
    identifications: [{ schemeId: 'SE:ORGNR', id: number }],
    // Fortnox writes the country by name.
    postalAddress: { countryCode: 'Sverige' },
    legalEntity: { registrationName: name, companyId: number, companyIdSchemeId: 'SE:ORGNR' },
  }
}

function salesDto(invoiceNumber: string, customer: PartyDto): SalesInvoiceDto {
  return {
    id: invoiceNumber,
    invoiceNumber,
    issueDate: '2026-03-01',
    dueDate: '2026-03-31',
    currencyCode: 'SEK',
    status: 'sent',
    supplier: { name: '', identifications: [] },
    customer,
    lines: [],
    legalMonetaryTotal: { payableAmount: { value: 1000, currencyCode: 'SEK' } },
    taxTotal: { taxAmount: { value: 200, currencyCode: 'SEK' } },
    paymentStatus: { paid: false, balance: { value: 1000, currencyCode: 'SEK' } },
  }
}

function options() {
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
    importSalesInvoices: true,
    importSupplierInvoices: false,
    importAssets: false,
    reconcileVouchers: false,
  }
}

/** The customer rows the step inserted. */
function insertedCustomers(): Record<string, unknown>[] {
  return mInsert.mock.calls
    .filter((call) => call[1] === 'customers')
    .flatMap((call) => call[2] as Record<string, unknown>[])
}

describe('executeMigration: the customer stub of a sales invoice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(fetchAllRows as Mock).mockResolvedValue([])
    mHydrateSales.mockImplementation(async (_p: unknown, _t: unknown, _c: unknown, given: unknown[]) => ({
      invoices: given,
      hydration: { needed: 0, hydrated: 0, failed: 0, skippedForBudget: 0 },
      unhydratedIds: new Set<string>(),
    }))
  })

  it('stores a personnummer encrypted on one privatperson stub, never in org_number', async () => {
    const person = customerParty('Anna Andersson', '19850101-1234')
    mListSales.mockResolvedValue([salesDto('1', person), salesDto('2', person)])

    const results = await executeMigration(options())

    const stubs = insertedCustomers()
    expect(stubs).toHaveLength(1)
    // Fortnox's "Sverige" is stored as the ISO code the column holds.
    expect(stubs[0]).toMatchObject({ customer_type: 'individual', org_number: null, country: 'SE' })
    expect(stubs[0].personal_number).toMatch(/^[0-9a-f]{76,255}$/)
    expect(decryptPersonnummer(stubs[0].personal_number as string)).toBe('19850101-1234')
    expect(JSON.stringify(stubs)).not.toContain('1985010')
    expect(results.salesInvoices).toMatchObject({ total: 2, imported: 2 })
  })

  it('keeps an organisationsnummer on a business stub, as before', async () => {
    mListSales.mockResolvedValue([salesDto('1', customerParty('Kund AB', '556055-1234'))])

    await executeMigration(options())

    const stubs = insertedCustomers()
    expect(stubs).toHaveLength(1)
    expect(stubs[0]).toMatchObject({ org_number: '556055-1234', personal_number: null })
    expect(stubs[0].customer_type).not.toBe('individual')
  })

  it('types a customer in "Sverige" as Swedish, not as an export customer outside the EU', async () => {
    // The type was read from the raw "Sverige", which is neither SE nor an EU
    // code, so the stub became non_eu_business and every new invoice to it
    // was locked to 0 % export.
    const noNumber: PartyDto = { name: 'Kund', identifications: [], postalAddress: { countryCode: 'Sverige' } }
    mListSales.mockResolvedValue([
      salesDto('1', customerParty('Kund AB', '556055-1234')),
      salesDto('2', noNumber),
    ])

    await executeMigration(options())

    const stubs = insertedCustomers()
    expect(stubs).toHaveLength(2)
    for (const stub of stubs) {
      expect(stub).toMatchObject({ customer_type: 'swedish_business', country: 'SE' })
    }
  })

  it('keeps a foreign customer foreign, with its country as a code', async () => {
    const foreign: PartyDto = { name: 'Kunde GmbH', identifications: [], postalAddress: { countryCode: 'Tyskland' } }
    mListSales.mockResolvedValue([salesDto('1', foreign)])

    await executeMigration(options())

    expect(insertedCustomers()).toEqual([
      expect.objectContaining({ customer_type: 'eu_business', country: 'DE' }),
    ])
  })
})
