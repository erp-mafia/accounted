import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Locks the orchestrator's error surfacing.
 *
 * Before this, every step's catch was log-and-continue, so a migration where
 * every provider call failed (e.g. Visma's "No access to module: api_standard"
 * when the customer's plan lacks the API module) reported success with zero
 * rows. The user saw "Allt är uppdaterat", retried, reconnected, and finally
 * filed the config issue as a bug.
 *
 * Contract:
 *  - Connection-level failures (auth expired, license missing, API module
 *    inactive) doom every remaining call: the orchestrator RETHROWS so the
 *    route answers with the structured code and its remediation.
 *  - Other failures stay non-fatal (one bad step must not discard the other
 *    steps' persisted rows) but are recorded on results.stepErrors so the
 *    result UI renders them instead of implying success.
 *  - A 403 on ONE register once the same token has already answered earlier in
 *    the run is not a connection-level failure at all: the Fortnox account
 *    that lacks leverantörsregister rights imported customers seconds before,
 *    so the run continues and the provider's own reason is what the user
 *    reads. Reconnecting could never have helped.
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
  // The orchestrator consumes the HYDRATED variants: mocking only the
  // Direct ones left the invoice steps calling undefined, which the step's
  // own try/catch swallowed into a recorded error, so the tests stayed green
  // while exercising nothing.
  fetchSalesInvoicesHydrated: vi.fn(),
  fetchSupplierInvoicesHydrated: vi.fn(),
}))

vi.mock('@/lib/invoices/bulk-reconcile-supplier-vouchers', () => ({
  reconcileSupplierInvoiceVouchers: vi.fn(),
}))

vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: vi.fn().mockResolvedValue([]),
}))

import { executeMigration } from '../lib/migration-orchestrator'
import {
  fetchCompanyInfoDirect,
  fetchCustomersDirect,
  fetchSuppliersDirect,
  fetchSalesInvoicesHydrated,
} from '@/lib/providers/provider-data-fetcher'
import { FortnoxApiError } from '@/lib/providers/fortnox/client'

const VISMA_MODULE_BODY =
  '{"ErrorCode":4002,"DeveloperErrorMessage":"ForbiddenRequestException - No access to module: api_standard","ErrorId":"x","Errors":[]}'

/** The live Fortnox answer for a supplier read the account may not make. */
const FORTNOX_SUPPLIER_BODY =
  '{"ErrorInformation":{"Error":1,"Message":"Saknar beh\u00f6righet f\u00f6r leverant\u00f6rsregister.","Code":2003275}}'

function vismaError(statusCode: number, body?: string): Error {
  const e = new Error(`Visma API error: ${statusCode}`) as Error & {
    statusCode: number
    body?: string
  }
  e.statusCode = statusCode
  e.body = body
  return e
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    consentId: 'consent-1',
    companyId: 'company-1',
    userId: 'user-1',
    supabase: {} as unknown as SupabaseClient,
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

describe('executeMigration: step error surfacing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rethrows when a step fails with an inactive API module (Visma 4002): the run is doomed', async () => {
    ;(fetchCustomersDirect as Mock).mockRejectedValue(vismaError(403, VISMA_MODULE_BODY))

    await expect(
      executeMigration(baseOptions({ importCustomers: true })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('rethrows a doomed company-info step too, instead of settling for imported:false', async () => {
    ;(fetchCompanyInfoDirect as Mock).mockRejectedValue(vismaError(403, VISMA_MODULE_BODY))

    await expect(
      executeMigration(baseOptions({ importCompanyInfo: true })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('records a non-fatal classified failure on results.stepErrors with the registry Swedish message', async () => {
    ;(fetchCustomersDirect as Mock).mockRejectedValue(vismaError(500))

    const results = await executeMigration(baseOptions({ importCustomers: true }))

    expect(results.stepErrors).toEqual([
      {
        step: 'customers',
        code: 'PROVIDER_UPSTREAM_ERROR',
        message: 'Leverantören svarade med ett fel. Försök igen om en stund.',
      },
    ])
    // The step failed before producing a result: no customers section.
    expect(results.customers).toBeUndefined()
  })

  it('records an unclassified failure with a generic Swedish sentence carrying the raw reason', async () => {
    ;(fetchCustomersDirect as Mock).mockRejectedValue(new Error('boom'))

    const results = await executeMigration(baseOptions({ importCustomers: true }))

    expect(results.stepErrors).toEqual([
      { step: 'customers', code: null, message: 'Leverantören svarade med ett fel: boom' },
    ])
  })

  it('keeps going when one register is closed on a token that already worked', async () => {
    // Customers came back fine, so the grant is provably alive: the suppliers
    // 403 is Fortnox refusing leverantörsregistret, not the connection dying.
    // Aborting here is what left sales invoices, supplier invoices, vouchers
    // and payment reconciliation unimported behind an "Återanslut" the user
    // could follow forever.
    ;(fetchCustomersDirect as Mock).mockResolvedValue([])
    ;(fetchSuppliersDirect as Mock).mockRejectedValue(
      new FortnoxApiError('Fortnox API error: 403', 403, FORTNOX_SUPPLIER_BODY),
    )
    ;(fetchSalesInvoicesHydrated as Mock).mockResolvedValue({
      invoices: [],
      hydration: undefined,
      unhydratedIds: new Set<string>(),
    })

    const results = await executeMigration(
      baseOptions({ importCustomers: true, importSuppliers: true, importSalesInvoices: true }),
    )

    expect(results.stepErrors).toHaveLength(1)
    expect(results.stepErrors![0].step).toBe('suppliers')
    expect(results.stepErrors![0].code).toBe('PROVIDER_RESOURCE_FORBIDDEN')
    // The provider's own sentence is the only part that names the register.
    expect(results.stepErrors![0].message).toContain('Saknar behörighet för leverantörsregister.')
    expect(results.stepErrors![0].message).not.toContain('Återanslut')
    // The steps after the closed register still ran.
    expect(fetchSalesInvoicesHydrated).toHaveBeenCalledTimes(1)
    expect(results.salesInvoices).toBeDefined()
  })

  it('does not treat a step that never called the provider as proof of the grant', async () => {
    // fetchCustomersDirect answers [] WITHOUT issuing any request when the
    // provider needs a company id the consent has none of (Bokio, Björn
    // Lundén) or does not expose the register (WINT suppliers). Reading that
    // resolved promise as "the token works" would downgrade a genuine auth
    // expiry on the next step to a per-register denial, and the run would
    // finish "successfully" with every section empty.
    ;(fetchCustomersDirect as Mock).mockResolvedValue([])
    ;(fetchSuppliersDirect as Mock).mockRejectedValue(vismaError(403))

    await expect(
      executeMigration(baseOptions({ importCustomers: true, importSuppliers: true })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('lets rows fetched earlier prove the grant for an opaque 403 later in the run', async () => {
    // Rows can only come from a real answer on this token, so the Bokio 403
    // that follows (empty body, nothing to read) is one closed register.
    ;(fetchCustomersDirect as Mock).mockResolvedValue([
      { id: 'cust-1', active: false, party: { name: 'Kund AB' } },
    ])
    ;(fetchSuppliersDirect as Mock).mockRejectedValue(vismaError(403))

    const results = await executeMigration(
      baseOptions({ importCustomers: true, importSuppliers: true }),
    )

    expect(results.customers).toMatchObject({ total: 1, imported: 0 })
    expect(results.stepErrors).toHaveLength(1)
    expect(results.stepErrors![0].step).toBe('suppliers')
    expect(results.stepErrors![0].code).toBe('PROVIDER_RESOURCE_FORBIDDEN')
    expect(results.stepErrors![0].message).not.toContain('Återanslut för att fortsätta')
  })

  it('still rethrows a 403 on the first provider call of the run: that one can be a dead grant', async () => {
    // Bokio answers with an empty body, so nothing distinguishes a revoked
    // grant from a closed register here. "Reconnect" stays the answer.
    ;(fetchCustomersDirect as Mock).mockRejectedValue(vismaError(403))

    await expect(
      executeMigration(baseOptions({ importCustomers: true })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('does not let an opaque 403 on the company-info probe abort the run', async () => {
    // Step 1 is the opening call, so nothing can have proven the grant yet.
    // Company information is optional metadata (this fetch used to swallow
    // every error and return null); a grant that really is dead says so on the
    // next step, which is still fatal.
    ;(fetchCompanyInfoDirect as Mock).mockRejectedValue(vismaError(403))
    ;(fetchCustomersDirect as Mock).mockResolvedValue([])

    const results = await executeMigration(
      baseOptions({ importCompanyInfo: true, importCustomers: true }),
    )

    expect(results.companyInfo).toEqual({ imported: false })
    expect(results.stepErrors).toHaveLength(1)
    expect(results.stepErrors![0].step).toBe('companyInfo')
    expect(results.stepErrors![0].code).toBe('PROVIDER_RESOURCE_FORBIDDEN')
    expect(fetchCustomersDirect).toHaveBeenCalledTimes(1)
  })

  it('returns no stepErrors when every enabled step succeeds', async () => {
    ;(fetchCustomersDirect as Mock).mockResolvedValue([])

    const results = await executeMigration(baseOptions({ importCustomers: true }))

    expect(results.stepErrors).toBeUndefined()
    expect(results.customers).toEqual({
      total: 0,
      imported: 0,
      updated: 0,
      skipped: 0,
      skipReasons: {},
    })
  })
})
