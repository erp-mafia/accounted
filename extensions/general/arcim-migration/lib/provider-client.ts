/**
 * Direct provider client: replaces arcim-client.ts.
 *
 * Instead of making HTTP calls to the Arcim Sync gateway, this module
 * performs consent/OTC operations directly against Supabase and delegates
 * data fetching to the provider clients in lib/providers/.
 */

import { createServiceClient } from '@/lib/supabase/server'
import type { ProviderName } from '@/lib/providers/types'
import { getOAuthConfig } from '@/lib/providers/oauth-config'
import { buildFortnoxAuthUrl } from '@/lib/providers/fortnox/oauth'
import { exchangeFortnoxCode } from '@/lib/providers/fortnox/oauth'
import { buildVismaAuthUrl, exchangeVismaCode } from '@/lib/providers/visma/oauth'
import { refreshBjornLundenToken } from '@/lib/providers/bjornlunden/oauth'
import { BjornLundenClient, BjornLundenApiError } from '@/lib/providers/bjornlunden/client'
import { exchangeBrioxCode } from '@/lib/providers/briox/oauth'
import { BrioxApiError } from '@/lib/providers/briox/client'
import type { ConsentRecord, OtcResponse } from '../types'

// Singleton (holds the rate limiter): used to validate BL User-Keys at submit
const bjornLundenClient = new BjornLundenClient()

/**
 * Thrown by submitProviderToken when the provider actively rejects the
 * submitted credentials (as opposed to a transient failure). The route maps
 * this to the PROVIDER_TOKEN_INVALID structured error so the wizard can tell
 * the user to re-check what they pasted.
 */
export class ProviderTokenInvalidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderTokenInvalidError'
  }
}

/**
 * Thrown when a consent does not exist OR does not belong to the caller's
 * company. The two cases are deliberately indistinguishable so a caller
 * cannot probe whether other tenants' consent IDs exist. The route maps this
 * to PROVIDER_CONSENT_NOT_FOUND (404).
 */
export class ConsentNotFoundError extends Error {
  constructor() {
    super('Consent not found')
    this.name = 'ConsentNotFoundError'
  }
}

// Re-export data fetching functions from the provider layer
export { resolveConsent } from '@/lib/providers/resolve-consent'
export {
  fetchCompanyInfoDirect,
  fetchCustomersDirect,
  fetchSuppliersDirect,
  fetchSalesInvoicesDirect,
  fetchSupplierInvoicesDirect,
} from '@/lib/providers/provider-data-fetcher'

// ── Consent lifecycle (direct Supabase) ─────────────────────────────

export async function createConsent(
  companyId: string,
  provider: ProviderName,
  name: string,
  orgNumber?: string,
  companyName?: string,
): Promise<ConsentRecord> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('provider_consents')
    .insert({
      company_id: companyId,
      name,
      provider,
      org_number: orgNumber,
      company_name: companyName,
      status: 0, // Created
    })
    .select('*')
    .single()

  if (error || !data) {
    throw new Error(`Failed to create consent: ${error?.message}`)
  }

  return {
    id: data.id,
    name: data.name,
    provider: data.provider as ProviderName,
    status: data.status,
    orgNumber: data.org_number,
    companyName: data.company_name,
  }
}

export async function listConsents(companyId: string): Promise<ConsentRecord[]> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('provider_consents')
    .select('*')
    .eq('company_id', companyId)
    .in('status', [0, 1]) // Created or Accepted
    .order('created_at', { ascending: false })

  if (error) {
    throw new Error(`Failed to list consents: ${error.message}`)
  }

  return (data ?? []).map(d => ({
    id: d.id,
    name: d.name,
    provider: d.provider as ProviderName,
    status: d.status,
    orgNumber: d.org_number,
    companyName: d.company_name,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
  }))
}

export async function getConsent(consentId: string): Promise<ConsentRecord> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('provider_consents')
    .select('*')
    .eq('id', consentId)
    .single()

  if (error || !data) {
    throw new Error(`Consent not found: ${error?.message}`)
  }

  return {
    id: data.id,
    name: data.name,
    provider: data.provider as ProviderName,
    status: data.status,
    orgNumber: data.org_number,
    companyName: data.company_name,
  }
}

export async function deleteConsent(consentId: string): Promise<void> {
  const supabase = createServiceClient()

  // Delete tokens first (cascade should handle this, but be explicit)
  await supabase.from('provider_consent_tokens').delete().eq('consent_id', consentId)
  await supabase.from('provider_otc').delete().eq('consent_id', consentId)

  const { error } = await supabase
    .from('provider_consents')
    .delete()
    .eq('id', consentId)

  if (error) {
    throw new Error(`Failed to delete consent: ${error.message}`)
  }
}

export async function generateOtc(
  consentId: string,
  expiresInMinutes: number = 60,
): Promise<OtcResponse> {
  const supabase = createServiceClient()

  const code = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString()

  const { error } = await supabase
    .from('provider_otc')
    .insert({
      code,
      consent_id: consentId,
      expires_at: expiresAt,
    })

  if (error) {
    throw new Error(`Failed to generate OTC: ${error.message}`)
  }

  return { code, consentId, expiresAt }
}

// ── OAuth helpers (direct provider calls) ───────────────────────────

export async function getAuthUrl(
  provider: ProviderName,
  state?: string,
  redirectUri?: string,
): Promise<{ url: string }> {
  const config = getOAuthConfig(provider)

  // Override redirect URI if provided (extension callback URL)
  const effectiveConfig = redirectUri
    ? { ...config, redirectUri }
    : config

  if (provider === 'fortnox') {
    const url = buildFortnoxAuthUrl(effectiveConfig, { state })
    return { url }
  }

  if (provider === 'visma') {
    const url = buildVismaAuthUrl(effectiveConfig, { state })
    return { url }
  }

  throw new Error(`OAuth is not supported for provider: ${provider}`)
}

export async function exchangeAuthToken(
  consentId: string,
  provider: ProviderName,
  code: string,
  redirectUri?: string,
): Promise<{ success: boolean; consentId: string }> {
  const config = getOAuthConfig(provider)
  const effectiveConfig = redirectUri ? { ...config, redirectUri } : config
  const supabase = createServiceClient()

  let tokenResponse: { access_token: string; refresh_token: string; expires_in: number }

  if (provider === 'fortnox') {
    tokenResponse = await exchangeFortnoxCode(effectiveConfig, code)
  } else if (provider === 'visma') {
    tokenResponse = await exchangeVismaCode(effectiveConfig, code)
  } else {
    throw new Error(`OAuth exchange not supported for provider: ${provider}`)
  }

  const expiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()

  // Store tokens
  await supabase
    .from('provider_consent_tokens')
    .upsert({
      consent_id: consentId,
      provider,
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token,
      token_expires_at: expiresAt,
    })

  // Mark consent as accepted
  await supabase
    .from('provider_consents')
    .update({ status: 1 })
    .eq('id', consentId)

  return { success: true, consentId }
}

export async function submitProviderToken(
  consentId: string,
  provider: ProviderName,
  apiToken: string,
  providerCompanyId: string | undefined,
  ownerCompanyId: string,
): Promise<{ success: boolean; consentId: string }> {
  const supabase = createServiceClient()

  // Ownership guard (IDOR): the consent must belong to the caller's company
  // before ANY write: this module runs on the service client, which bypasses
  // RLS, so this check is the only tenant boundary. Mirrors resolveConsent()
  // in lib/providers/resolve-consent.ts. A consent that exists but belongs to
  // another company throws the same not-found error as a nonexistent one.
  const { data: ownedRows } = await supabase
    .from('provider_consents')
    .select('id')
    .eq('id', consentId)
    .eq('company_id', ownerCompanyId)
    .limit(1)

  if (!ownedRows || ownedRows.length === 0) {
    throw new ConsentNotFoundError()
  }

  let accessToken = apiToken
  let refreshToken: string | null = null
  let tokenExpiresAt: string | null = null

  // BL uses app-level client credentials: get a real token, then prove the
  // pasted User-Key actually opens a company before storing anything.
  if (provider === 'bjornlunden') {
    if (!providerCompanyId) {
      throw new ProviderTokenInvalidError('Björn Lundén requires a company key (User-Key)')
    }
    const tokenResponse = await refreshBjornLundenToken()
    accessToken = tokenResponse.access_token
    tokenExpiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()

    // Sandbox-verified: an unknown User-Key makes /details answer 500 (BL
    // fails to bind the company database), not 401/403. Without this probe a
    // typo'd GUID is stored silently and only surfaces as a confusing failure
    // at preview. retry:false makes a bad key fail fast instead of burning
    // the client's full retry budget on the "retryable" 500.
    try {
      const details = await bjornLundenClient.get<Record<string, unknown>>(
        accessToken,
        providerCompanyId,
        '/details',
        { retry: false },
      )
      // Bonus from the probe: label the consent with the company name so the
      // wizard's connection list shows which BL company was linked.
      const blCompanyName = typeof details?.['name'] === 'string' ? (details['name'] as string).trim() : ''
      if (blCompanyName) {
        await supabase
          .from('provider_consents')
          .update({ company_name: blCompanyName })
          .eq('id', consentId)
      }
    } catch (error) {
      if (error instanceof BjornLundenApiError) {
        // 429 and gateway-style 5xx (502/503/504) are transient provider
        // failures, not a verdict on the key: rethrow so the route reports a
        // generic submit failure instead of "your key is wrong". 500 stays
        // mapped to invalid credentials: per the sandbox finding above, 500
        // IS the bad-key signal at BL. Tradeoff: a genuine BL 500 outage also
        // reads as a rejected key.
        if (error.statusCode === 429 || error.statusCode >= 501) {
          throw error
        }
        throw new ProviderTokenInvalidError(
          `Björn Lundén rejected the company key (HTTP ${error.statusCode})`,
        )
      }
      throw error
    }
  }

  // Briox: the user pastes an application token + account ID, which we
  // exchange ONCE for an access/refresh token pair. Storing the raw
  // application token would fail on every data call.
  if (provider === 'briox') {
    if (!providerCompanyId) {
      throw new ProviderTokenInvalidError('Briox requires an account ID (clientid)')
    }
    try {
      const tokenResponse = await exchangeBrioxCode(providerCompanyId, apiToken)
      accessToken = tokenResponse.access_token
      refreshToken = tokenResponse.refresh_token
      tokenExpiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
    } catch (error) {
      // /token answers 400/401/404 for a wrong account ID or application
      // token: surface as invalid credentials, not a server error.
      if (error instanceof BrioxApiError && error.statusCode < 500 && error.statusCode !== 429) {
        throw new ProviderTokenInvalidError(
          `Briox rejected the credentials (HTTP ${error.statusCode})`,
        )
      }
      throw error
    }
  }

  // Store tokens: consent stays at status 0 until migration/SIE import completes
  await supabase
    .from('provider_consent_tokens')
    .upsert({
      consent_id: consentId,
      provider,
      access_token: accessToken,
      refresh_token: refreshToken,
      token_expires_at: tokenExpiresAt,
      provider_company_id: providerCompanyId,
    })

  return { success: true, consentId }
}

/** Mark a consent as accepted (status 1): call after migration or SIE import succeeds */
export async function acceptConsent(consentId: string): Promise<void> {
  const supabase = createServiceClient()
  await supabase
    .from('provider_consents')
    .update({ status: 1 })
    .eq('id', consentId)
}
