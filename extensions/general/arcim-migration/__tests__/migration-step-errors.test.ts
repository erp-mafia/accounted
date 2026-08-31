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
} from '@/lib/providers/provider-data-fetcher'

const VISMA_MODULE_BODY =
  '{"ErrorCode":4002,"DeveloperErrorMessage":"ForbiddenRequestException - No access to module: api_standard","ErrorId":"x","Errors":[]}'

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
