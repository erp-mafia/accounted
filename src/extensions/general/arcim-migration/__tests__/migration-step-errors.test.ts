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
 *    the run is not a connection-level failure at all, so the run continues
 *    and the provider's own reason is what the user reads. Reconnecting could
 *    never have helped.
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
}))

vi.mock('../lib/import-assets', () => {
  class FortnoxAssetScopesRequiredError extends Error {}
  return { importProviderAssets: vi.fn(), FortnoxAssetScopesRequiredError }
})

vi.mock('@/lib/invoices/bulk-reconcile-supplier-vouchers', () => ({
  reconcileSupplierInvoiceVouchers: vi.fn(),
}))

vi.mock('@/lib/parties/suggest', () => ({
  suggestPartiesForCompany: vi.fn().mockResolvedValue({ created: 0, attached: 0, skipped: 0 }),
}))

import { executeMigration } from '../lib/migration-orchestrator'
import { FortnoxAssetScopesRequiredError, importProviderAssets } from '../lib/import-assets'
import { fetchCompanyInfoDirect } from '@/lib/providers/provider-data-fetcher'
import { suggestPartiesForCompany } from '@/lib/parties/suggest'
import { FortnoxApiError } from '@/lib/providers/fortnox/client'
import { createTableMockSupabase } from '@/tests/helpers'

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
    importAssets: false,
    reconcileVouchers: false,
    suggestParties: false,
    ...overrides,
  }
}

describe('executeMigration: step error surfacing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rethrows when a step fails with an inactive API module (Visma 4002): the run is doomed', async () => {
    ;(importProviderAssets as Mock).mockRejectedValue(vismaError(403, VISMA_MODULE_BODY))

    await expect(
      executeMigration(baseOptions({ importAssets: true })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('rethrows a doomed company-info step too, instead of settling for imported:false', async () => {
    ;(fetchCompanyInfoDirect as Mock).mockRejectedValue(vismaError(403, VISMA_MODULE_BODY))

    await expect(
      executeMigration(baseOptions({ importCompanyInfo: true })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('records a non-fatal classified failure on results.stepErrors with the registry Swedish message', async () => {
    ;(importProviderAssets as Mock).mockRejectedValue(vismaError(500))

    const results = await executeMigration(baseOptions({ importAssets: true }))

    expect(results.stepErrors).toEqual([
      {
        step: 'assets',
        code: 'PROVIDER_UPSTREAM_ERROR',
        message: 'Leverantören svarade med ett fel. Försök igen om en stund.',
      },
    ])
    // The step failed before producing a result: no assets section.
    expect(results.assets).toBeUndefined()
  })

  it('records an unclassified failure with a generic Swedish sentence carrying the raw reason', async () => {
    ;(importProviderAssets as Mock).mockRejectedValue(new Error('boom'))

    const results = await executeMigration(baseOptions({ importAssets: true }))

    expect(results.stepErrors).toEqual([
      { step: 'assets', code: null, message: 'Leverantören svarade med ett fel: boom' },
    ])
  })

  it('names a register Fortnox refuses with HTTP 400 for the connecting user, not a bare 400 (crm#1014)', async () => {
    // The live answer for a Fortnox user who may not read a register. It used
    // to land as "Leverantören svarade med ett fel: Fortnox API error: 400 Bad
    // Request", which says nothing about what to do.
    ;(importProviderAssets as Mock).mockRejectedValue(new FortnoxApiError('Fortnox API error: 400', 400,
      '{"ErrorInformation":{"error":1,"message":"Saknar behörighet för leverantörsfaktura.","code":2002182}}'))

    const results = await executeMigration(baseOptions({ importAssets: true }))

    expect(results.stepErrors).toEqual([expect.objectContaining({ step: 'assets', code: 'PROVIDER_RESOURCE_FORBIDDEN' })])
    expect(results.stepErrors![0].message).toContain('användaren som kopplade Fortnox')
    expect(results.stepErrors![0].message).toContain('Saknar behörighet för leverantörsfaktura.')
  })

  it('does not treat a step that never called the provider as proof of the grant', async () => {
    // A null company answer also means "no company-information resource for
    // this provider", decided before any request goes out. Reading that as
    // "the token works" would downgrade a genuine auth expiry on the next step
    // to a per-register denial, and the run would finish "successfully" with
    // every section empty.
    ;(fetchCompanyInfoDirect as Mock).mockResolvedValue(null)
    ;(importProviderAssets as Mock).mockRejectedValue(vismaError(403))

    await expect(
      executeMigration(baseOptions({ importCompanyInfo: true, importAssets: true })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('lets data fetched earlier in the run prove the grant for an opaque 403 later', async () => {
    const db = createTableMockSupabase({ company_settings: { data: { company_name: 'Bolaget AB' } } })
    ;(fetchCompanyInfoDirect as Mock).mockResolvedValue({ companyName: 'Bolaget AB', address: {} })
    ;(importProviderAssets as Mock).mockRejectedValue(vismaError(403))

    const results = await executeMigration(
      baseOptions({ importCompanyInfo: true, importAssets: true, supabase: db.supabase as unknown as SupabaseClient }),
    )

    expect(results.stepErrors).toEqual([expect.objectContaining({ step: 'assets', code: 'PROVIDER_RESOURCE_FORBIDDEN' })])
    expect(results.stepErrors![0].message).not.toContain('Återanslut för att fortsätta')
  })

  it('reads an opaque 403 as one closed register when an earlier request proved the grant', async () => {
    ;(importProviderAssets as Mock).mockRejectedValue(vismaError(403))

    const results = await executeMigration(baseOptions({ importAssets: true, grantProven: true }))

    expect(results.stepErrors).toHaveLength(1)
    expect(results.stepErrors![0].code).toBe('PROVIDER_RESOURCE_FORBIDDEN')
  })

  it('still rethrows a 403 on the first provider call of the run: that one can be a dead grant', async () => {
    // Bokio answers with an empty body, so nothing distinguishes a revoked
    // grant from a closed register here. "Reconnect" stays the answer.
    ;(importProviderAssets as Mock).mockRejectedValue(vismaError(403))

    await expect(
      executeMigration(baseOptions({ importAssets: true })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('does not let an opaque 403 on the company-info probe abort the run', async () => {
    // Step 1 is the opening call, so nothing can have proven the grant yet.
    // Company information is optional metadata (this fetch used to swallow
    // every error and return null); a grant that really is dead says so on the
    // next step, which is still fatal.
    ;(fetchCompanyInfoDirect as Mock).mockRejectedValue(vismaError(403))
    ;(importProviderAssets as Mock).mockResolvedValue(null)

    const results = await executeMigration(baseOptions({ importCompanyInfo: true, importAssets: true }))

    expect(results.companyInfo).toEqual({ imported: false })
    expect(results.stepErrors).toHaveLength(1)
    expect(results.stepErrors![0].step).toBe('companyInfo')
    expect(results.stepErrors![0].code).toBe('PROVIDER_RESOURCE_FORBIDDEN')
    expect(importProviderAssets).toHaveBeenCalledTimes(1)
  })

  it('reports a consent without the Fortnox assets scope instead of failing the run', async () => {
    ;(importProviderAssets as Mock).mockRejectedValue(new FortnoxAssetScopesRequiredError())

    const results = await executeMigration(baseOptions({ importAssets: true }))

    expect(results.assets).toEqual({ total: 0, imported: 0, skipped: 0, scopesMissing: true })
    expect(results.stepErrors).toBeUndefined()
  })

  describe('the company fill, which is an owner\'s or admin\'s to make', () => {
    const fill = (role: string) => {
      ;(fetchCompanyInfoDirect as Mock).mockResolvedValue({ companyName: 'Bolaget AB', address: {} })
      return createTableMockSupabase({
        company_settings: { data: { company_name: null, org_number: null, vat_number: null } },
        company_members: { data: { role } },
      })
    }

    it('says so when a member runs the import, and writes nothing', async () => {
      const db = fill('member')

      const results = await executeMigration(
        baseOptions({ importCompanyInfo: true, supabase: db.supabase as unknown as SupabaseClient }),
      )

      expect(db.findCall('company_settings', 'update')).toBeUndefined()
      expect(results.companyInfo).toEqual({ imported: false })
      expect(results.stepErrors).toEqual([
        {
          step: 'companyInfo',
          code: 'FORBIDDEN',
          message: 'Bara företagets ägare eller en administratör kan ändra företagsinställningarna.',
        },
      ])
    })

    it('says so when the write matched no row', async () => {
      const db = fill('owner')
      db.setTable('company_settings', [
        { data: { company_name: null, org_number: null, vat_number: null } },
        { data: null },
      ])

      const results = await executeMigration(
        baseOptions({ importCompanyInfo: true, supabase: db.supabase as unknown as SupabaseClient }),
      )

      expect(results.companyInfo).toEqual({ imported: false })
      expect(results.stepErrors?.[0]).toMatchObject({ step: 'companyInfo', code: 'NOT_FOUND' })
    })

    it('reports the import when an owner runs it', async () => {
      const db = fill('owner')

      const results = await executeMigration(
        baseOptions({ importCompanyInfo: true, supabase: db.supabase as unknown as SupabaseClient }),
      )

      expect(db.findCall('company_settings', 'update')?.[0]).toMatchObject({ company_name: 'Bolaget AB' })
      expect(results.companyInfo).toEqual({ imported: true })
      expect(results.stepErrors).toBeUndefined()
    })
  })

  it('returns no stepErrors when every enabled step succeeds', async () => {
    ;(importProviderAssets as Mock).mockResolvedValue({ total: 2, imported: 2, skipped: 0 })

    const results = await executeMigration(baseOptions({ importAssets: true }))

    expect(results.stepErrors).toBeUndefined()
    expect(results.assets).toEqual({ total: 2, imported: 2, skipped: 0 })
  })
})

describe('executeMigration: suggestParties', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs the party scan by default and skips it when the request says so', async () => {
    await executeMigration(baseOptions({ suggestParties: undefined }))
    expect(suggestPartiesForCompany).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    await executeMigration(baseOptions({ suggestParties: false }))
    expect(suggestPartiesForCompany).not.toHaveBeenCalled()
  })
})
