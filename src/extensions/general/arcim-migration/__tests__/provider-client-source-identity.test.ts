import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

/**
 * ensureConsentSourceIdentity() fills the durable source identity that
 * create_provider_migration_job requires (consent org number, or the
 * provider's tenant id) for consents connected before the OAuth exchange
 * recorded it. The identity always comes from what the credentials open,
 * behind the same mismatch guard as the exchange, never from the Accounted
 * company's own org number.
 */

vi.mock('@/lib/providers/provider-data-fetcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/providers/provider-data-fetcher')>()),
  fetchCompanyInfoDirect: vi.fn(),
}))

vi.mock('@/lib/providers/resolve-consent', () => ({ resolveConsent: vi.fn() }))

let serviceClient: ReturnType<typeof createQueuedMockSupabase>

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => serviceClient.supabase,
  createClient: vi.fn(),
}))

import { ensureConsentSourceIdentity, ProviderCompanyMismatchError } from '../lib/provider-client'
import { fetchCompanyInfoDirect } from '@/lib/providers/provider-data-fetcher'
import { resolveConsent } from '@/lib/providers/resolve-consent'

// Both pass normalizeOrgNumber's Luhn check.
const TARGET_ORG = '5560160680'
const OTHER_ORG = '5567037485'

function useDb(results: { data?: unknown; error?: unknown }[]) {
  serviceClient = createQueuedMockSupabase()
  serviceClient.enqueueMany(results)
  return serviceClient
}

describe('ensureConsentSourceIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    ;(resolveConsent as Mock).mockResolvedValue({ consent: {}, accessToken: 'access-1' })
  })

  it('leaves a consent that already has an org number alone and calls no provider', async () => {
    const db = useDb([{ data: { provider: 'bokio', org_number: '556016-0680' } }])
    await expect(ensureConsentSourceIdentity('company-1', 'consent-1')).resolves.toBe('present')
    expect(fetchCompanyInfoDirect).not.toHaveBeenCalled()
    expect(db.findCall('provider_consents', 'update')).toBeUndefined()
  })

  it('treats a provider tenant id as an identity, like the RPC does', async () => {
    const db = useDb([{ data: { provider: 'briox', org_number: null } }, { data: { provider_company_id: 'acct-9' } }])
    await expect(ensureConsentSourceIdentity('company-1', 'consent-1')).resolves.toBe('present')
    expect(fetchCompanyInfoDirect).not.toHaveBeenCalled()
    expect(db.findCall('provider_consents', 'update')).toBeUndefined()
  })

  it('fills the org number from the provider for a Fortnox consent without identity', async () => {
    const db = useDb([
      { data: { provider: 'fortnox', org_number: null } },
      { data: { provider_company_id: null } },
      { data: { org_number: '556016-0680' } },
      { data: null },
    ])
    ;(fetchCompanyInfoDirect as Mock).mockResolvedValue({ companyName: 'Bolag AB', organizationNumber: '556016-0680' })

    await expect(ensureConsentSourceIdentity('company-1', 'consent-1')).resolves.toBe('filled')

    expect(resolveConsent).toHaveBeenCalledWith('company-1', 'consent-1')
    expect(fetchCompanyInfoDirect).toHaveBeenCalledWith('fortnox', 'access-1', undefined)
    expect(db.findCall('provider_consents', 'update')?.[0]).toEqual({ org_number: TARGET_ORG })
    // Tenant-scoped and idempotent: only a still-empty column is written.
    expect(db.findCalls('provider_consents', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(db.findCall('provider_consents', 'or')?.[0]).toBe('org_number.is.null,org_number.eq.')
  })

  it('fills a Visma consent from CorporateIdentityNumber even when the Accounted company has no org number', async () => {
    const db = useDb([
      { data: { provider: 'visma', org_number: '' } },
      { data: { provider_company_id: '' } },
      { data: { org_number: null } },
      { data: null },
    ])
    ;(fetchCompanyInfoDirect as Mock).mockResolvedValue({ companyName: 'Bolag AB', organizationNumber: '16556016-0680' })

    await expect(ensureConsentSourceIdentity('company-1', 'consent-1')).resolves.toBe('filled')
    expect(db.findCall('provider_consents', 'update')?.[0]).toEqual({ org_number: TARGET_ORG })
  })

  it('refuses credentials that open a different company and records nothing', async () => {
    const db = useDb([
      { data: { provider: 'fortnox', org_number: null } },
      { data: { provider_company_id: null } },
      { data: { org_number: TARGET_ORG } },
    ])
    ;(fetchCompanyInfoDirect as Mock).mockResolvedValue({ companyName: 'Annat Bolag AB', organizationNumber: OTHER_ORG })

    const error = await ensureConsentSourceIdentity('company-1', 'consent-1').catch((e) => e)
    expect(error).toBeInstanceOf(ProviderCompanyMismatchError)
    expect(db.findCall('provider_consents', 'update')).toBeUndefined()
  })

  it('never invents an identity when the provider reports no valid org number', async () => {
    const db = useDb([
      { data: { provider: 'fortnox', org_number: null } },
      { data: { provider_company_id: null } },
    ])
    ;(fetchCompanyInfoDirect as Mock).mockResolvedValue({ companyName: 'Bolag AB', organizationNumber: '123' })

    await expect(ensureConsentSourceIdentity('company-1', 'consent-1')).resolves.toBe('unavailable')
    expect(db.findCall('companies', 'select')).toBeUndefined()
    expect(db.findCall('provider_consents', 'update')).toBeUndefined()
  })

  it('reports unavailable, without throwing, when the provider cannot be reached', async () => {
    const db = useDb([
      { data: { provider: 'fortnox', org_number: null } },
      { data: { provider_company_id: null } },
    ])
    ;(resolveConsent as Mock).mockRejectedValue({ status: 401, message: 'expired' })

    await expect(ensureConsentSourceIdentity('company-1', 'consent-1')).resolves.toBe('unavailable')
    expect(db.findCall('provider_consents', 'update')).toBeUndefined()
  })

  it('does nothing for a consent that is not this company\'s or has no tokens', async () => {
    useDb([{ data: null }])
    await expect(ensureConsentSourceIdentity('company-1', 'consent-1')).resolves.toBe('unavailable')
    useDb([{ data: { provider: 'fortnox', org_number: null } }, { data: null }])
    await expect(ensureConsentSourceIdentity('company-1', 'consent-1')).resolves.toBe('unavailable')
    expect(resolveConsent).not.toHaveBeenCalled()
  })
})
