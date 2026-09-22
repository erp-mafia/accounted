import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

/**
 * exchangeAuthToken() must refuse valid OAuth tokens that open the WRONG
 * company.
 *
 * Bokio and WINT already had this guard in submitProviderToken: a token that
 * works plus the wrong company imports a foreign legal entity's customers,
 * suppliers and invoices into this ledger with no error at all. The OAuth
 * providers (Fortnox, Visma) had nothing: whichever company the user (or
 * whoever lured them) signed in to at the provider was bound to the consent.
 *
 * Rule under test: only a confident mismatch blocks. A missing org number on
 * either side, or a failed company-information call, is not evidence and the
 * exchange completes as before.
 */

vi.mock('@/lib/providers/oauth-config', () => ({
  getOAuthConfig: vi.fn(() => ({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://app.example/api/extensions/ext/arcim-migration/callback',
  })),
}))

vi.mock('@/lib/providers/fortnox/oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/providers/fortnox/oauth')>()),
  exchangeFortnoxCode: vi.fn(),
}))

vi.mock('@/lib/providers/provider-data-fetcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/providers/provider-data-fetcher')>()),
  fetchCompanyInfoDirect: vi.fn(),
}))

let serviceClient: ReturnType<typeof createQueuedMockSupabase>

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => serviceClient.supabase,
  createClient: vi.fn(),
}))

import { exchangeAuthToken, ProviderCompanyMismatchError } from '../lib/provider-client'
import { exchangeFortnoxCode } from '@/lib/providers/fortnox/oauth'
import { fetchCompanyInfoDirect } from '@/lib/providers/provider-data-fetcher'

// Both pass normalizeOrgNumber's Luhn check: Spotify AB and Ericsson.
const TARGET_ORG = '5560160680'
const OTHER_ORG = '5567037485'

const TOKENS = { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }

/**
 * Queue results in exchangeAuthToken's `from` order: provider_consents
 * (company_id), companies (org_number), then the token upsert and the status
 * update (whose results are not read).
 */
function useDb(consentCompanyId: string | null, targetOrgNumber: string | null) {
  serviceClient = createQueuedMockSupabase()
  serviceClient.enqueueMany([
    { data: consentCompanyId ? { company_id: consentCompanyId } : null },
    { data: { org_number: targetOrgNumber } },
  ])
  return serviceClient
}

describe('exchangeAuthToken: provider company must match the consent company', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(exchangeFortnoxCode as Mock).mockResolvedValue(TOKENS)
  })

  it('refuses tokens for a different company and stores nothing', async () => {
    const db = useDb('company-1', '556016-0680')
    ;(fetchCompanyInfoDirect as Mock).mockResolvedValue({
      companyName: 'Annat Bolag AB',
      organizationNumber: '556703-7485',
    })

    const error = await exchangeAuthToken('consent-1', 'fortnox', 'code', 'https://cb').catch((e) => e)

    expect(error).toBeInstanceOf(ProviderCompanyMismatchError)
    expect((error as ProviderCompanyMismatchError).expectedOrgNumber).toBe(TARGET_ORG)
    expect((error as ProviderCompanyMismatchError).actualOrgNumber).toBe(OTHER_ORG)
    expect((error as ProviderCompanyMismatchError).actualCompanyName).toBe('Annat Bolag AB')
    // The one-shot code was exchanged (that is how we learned the company),
    // but nothing about the result may land in the database.
    expect(db.findCall('provider_consent_tokens', 'upsert')).toBeUndefined()
    expect(db.findCall('provider_consents', 'update')).toBeUndefined()
  })

  it('checks the company the token opens, using the fresh access token', async () => {
    useDb('company-1', TARGET_ORG)
    ;(fetchCompanyInfoDirect as Mock).mockResolvedValue({
      companyName: 'Rätt Bolag AB',
      organizationNumber: TARGET_ORG,
    })

    await exchangeAuthToken('consent-1', 'fortnox', 'code', 'https://cb')

    expect(fetchCompanyInfoDirect).toHaveBeenCalledWith('fortnox', 'access-1')
  })

  it('stores the tokens and accepts the consent when the org numbers agree', async () => {
    const db = useDb('company-1', '556016-0680')
    ;(fetchCompanyInfoDirect as Mock).mockResolvedValue({
      companyName: 'Rätt Bolag AB',
      organizationNumber: TARGET_ORG,
    })

    await expect(exchangeAuthToken('consent-1', 'fortnox', 'code', 'https://cb')).resolves.toEqual({
      success: true,
      consentId: 'consent-1',
    })

    const upsert = db.findCall('provider_consent_tokens', 'upsert')?.[0] as Record<string, unknown>
    expect(upsert).toMatchObject({
      consent_id: 'consent-1',
      provider: 'fortnox',
      access_token: 'access-1',
      refresh_token: 'refresh-1',
    })
    expect(db.findCall('provider_consents', 'update')?.[0]).toEqual({ status: 1 })
  })

  it('does not block when the provider reports no org number', async () => {
    const db = useDb('company-1', TARGET_ORG)
    ;(fetchCompanyInfoDirect as Mock).mockResolvedValue({ companyName: 'Namnlöst AB' })

    await exchangeAuthToken('consent-1', 'fortnox', 'code', 'https://cb')

    expect(db.findCall('provider_consent_tokens', 'upsert')).toBeDefined()
    // Nothing to compare against: the target company is not even looked up.
    expect(db.findCall('companies', 'select')).toBeUndefined()
  })

  it('does not block when the Accounted company has no org number', async () => {
    const db = useDb('company-1', null)
    ;(fetchCompanyInfoDirect as Mock).mockResolvedValue({
      companyName: 'Annat Bolag AB',
      organizationNumber: OTHER_ORG,
    })

    await exchangeAuthToken('consent-1', 'fortnox', 'code', 'https://cb')

    expect(db.findCall('provider_consent_tokens', 'upsert')).toBeDefined()
  })

  it('does not block when the company-information call fails', async () => {
    // A scope the app registration lacks, or a provider hiccup, is not a
    // verdict on identity. The tokens are valid (the exchange succeeded).
    const db = useDb('company-1', TARGET_ORG)
    ;(fetchCompanyInfoDirect as Mock).mockRejectedValue(new Error('403 forbidden'))

    await expect(exchangeAuthToken('consent-1', 'fortnox', 'code', 'https://cb')).resolves.toEqual({
      success: true,
      consentId: 'consent-1',
    })
    expect(db.findCall('provider_consent_tokens', 'upsert')).toBeDefined()
  })
})
