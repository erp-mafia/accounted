/**
 * Direct provider client: replaces arcim-client.ts.
 *
 * Instead of making HTTP calls to the Arcim Sync gateway, this module
 * performs consent/OTC operations directly against Supabase and delegates
 * data fetching to the provider clients in lib/providers/.
 */

import { randomBytes } from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/server'
import type { ProviderName } from '@/lib/providers/types'
import { getOAuthConfig } from '@/lib/providers/oauth-config'
import {
  buildFortnoxAuthUrl,
  fortnoxConsentScopes,
} from '@/lib/providers/fortnox/oauth'
import { exchangeFortnoxCode } from '@/lib/providers/fortnox/oauth'
import { buildVismaAuthUrl, exchangeVismaCode } from '@/lib/providers/visma/oauth'
import { refreshBjornLundenToken } from '@/lib/providers/bjornlunden/oauth'
import { BjornLundenClient, BjornLundenApiError } from '@/lib/providers/bjornlunden/client'
import { exchangeBrioxCode } from '@/lib/providers/briox/oauth'
import { BrioxApiError } from '@/lib/providers/briox/client'
import {
  BokioClient,
  BokioApiError,
  normalizeBokioAccessToken,
} from '@/lib/providers/bokio/client'
import { WintClient, WintApiError } from '@/lib/providers/wint/client'
import { loginWint, WintLoginRejectedError } from '@/lib/providers/wint/oauth'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { fetchCompanyInfoDirect } from '@/lib/providers/provider-data-fetcher'
import type { CompanyInformationDto } from '@/lib/providers/dto'
import { createLogger } from '@/lib/logger'
import type { ConsentRecord, OtcResponse } from '../types'
import { decryptHandoffValue, encryptHandoffValue } from './handoff-crypto'

const log = createLogger('extensions/arcim-migration/provider-client')

// Singleton (holds the rate limiter): used to validate BL User-Keys at submit
const bjornLundenClient = new BjornLundenClient()

// Singleton (holds the rate limiter): used to verify Bokio company identity
const bokioClient = new BokioClient()

// Singleton (holds the rate limiter): used to verify the WINT login at submit
const wintClient = new WintClient()

/**
 * Thrown by submitProviderToken when the provider actively rejects the
 * submitted credentials (as opposed to a transient failure). The route maps
 * this to the PROVIDER_TOKEN_INVALID structured error so the wizard can tell
 * the user to re-check what they pasted.
 */
export class ProviderTokenInvalidError extends Error {
  constructor(
    message: string,
    public readonly kind: 'credentials' | 'company-not-found' = 'credentials',
  ) {
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

/**
 * Thrown when the credentials are valid but open a company whose org number is
 * not the one being imported into. Reported as PROVIDER_COMPANY_MISMATCH (422).
 *
 * The failure this prevents is silent and expensive: a token that works plus a
 * company id for the wrong company imports a FOREIGN legal entity's customers,
 * suppliers and invoices into this ledger. Nothing errors, so the first signal
 * is the user noticing their books are full of a stranger's data. Both org
 * numbers are carried on the error so the wizard can name the two companies.
 */
export class ProviderCompanyMismatchError extends Error {
  constructor(
    public readonly expectedOrgNumber: string,
    public readonly actualOrgNumber: string,
    public readonly actualCompanyName: string | null,
  ) {
    super(
      `Provider company mismatch: credentials open ${actualOrgNumber}, ` +
      `but the target company is ${expectedOrgNumber}`,
    )
    this.name = 'ProviderCompanyMismatchError'
  }
}

// Re-export data fetching functions from the provider layer
export { resolveConsent } from '@/lib/providers/resolve-consent'
export { fetchCompanyInfoDirect } from '@/lib/providers/provider-data-fetcher'

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

/**
 * Read a consent, scoped to the company that owns it.
 *
 * `ownerCompanyId` is mandatory: this module runs on the service client, which
 * bypasses RLS, so the predicate below is the only tenant boundary. Without it
 * any authenticated user could pass a foreign consent id and read back its
 * status/provider/company name, i.e. a cross-tenant existence oracle. A consent
 * that exists but belongs to another company throws the same
 * ConsentNotFoundError as one that does not exist. Mirrors the guard in
 * submitProviderToken() and resolveConsent().
 */
export async function getConsent(
  consentId: string,
  ownerCompanyId: string,
): Promise<ConsentRecord> {
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('provider_consents')
    .select('*')
    .eq('id', consentId)
    .eq('company_id', ownerCompanyId)
    .maybeSingle()

  if (error || !data) {
    throw new ConsentNotFoundError()
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

/**
 * Mint a one-time code bound to a consent.
 *
 * The code doubles as the OAuth `state` parameter: it is an opaque random
 * identifier for a server-written row, and the callback resolves the consent
 * from that row rather than from anything the browser carried. 32 random bytes
 * (not the previous 16 hex chars of a UUID) because this value is now the only
 * thing standing between an attacker and binding their provider account to
 * someone else's consent.
 *
 * Default lifetime is 10 minutes: the state only has to survive the redirect
 * to the provider's login page and back. OAuth guidance puts state/OTC
 * lifetimes at 5-10 minutes; every extra minute widens the window in which a
 * leaked or phished state can still be consumed.
 *
 * `initiatedByUserId` is the user who clicked connect. The row remembers it so
 * the callback can insist that the SAME user's browser session completes the
 * flow: the state proves the callback belongs to a flow we started, not that
 * the person finishing it is the person who started it.
 */
export async function generateOtc(
  consentId: string,
  initiatedByUserId: string,
  origin: string | null = null,
  expiresInMinutes: number = 10,
): Promise<OtcResponse> {
  const supabase = createServiceClient()

  const code = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString()

  const { error } = await supabase
    .from('provider_otc')
    .insert({
      code,
      consent_id: consentId,
      user_id: initiatedByUserId,
      origin,
      expires_at: expiresAt,
    })

  if (error) {
    throw new Error(`Failed to generate OTC: ${error.message}`)
  }

  return { code, consentId, expiresAt }
}

/**
 * Atomically consume an OAuth `state` token and resolve what it was minted for.
 *
 * The single UPDATE is the entire check: `used_at IS NULL` and
 * `expires_at > now` sit in the WHERE clause, so a replayed callback loses the
 * row-lock race (under READ COMMITTED the second statement re-evaluates the
 * predicate after the first commits, matches nothing, and updates 0 rows).
 * There is no read-then-write window to exploit.
 *
 * The provider is read from the consent row (written server-side at connect
 * time), never from the callback query string.
 *
 * Returns null for every failure mode: unknown/forged state, expired state,
 * already-consumed state, deleted consent. Callers must not distinguish them,
 * that distinction is exactly the oracle this function exists to remove.
 *
 * `userId` is the initiator recorded at generateOtc time (null only for rows
 * minted before provider_otc.user_id existed). The callback compares it to the
 * completing browser's session before exchanging the code.
 */
export async function consumeOAuthState(
  state: string,
): Promise<{ consentId: string; provider: ProviderName; userId: string | null; origin: string | null } | null> {
  const supabase = createServiceClient()
  const now = new Date().toISOString()

  const { data: consumed, error } = await supabase
    .from('provider_otc')
    .update({ used_at: now })
    .eq('code', state)
    .is('used_at', null)
    .is('provider_code', null)
    .is('provider_error', null)
    .gt('expires_at', now)
    .select('consent_id, user_id, origin')
    .maybeSingle()

  if (error || !consumed?.consent_id) {
    return null
  }

  const { data: consent } = await supabase
    .from('provider_consents')
    .select('provider')
    .eq('id', consumed.consent_id)
    .maybeSingle()

  if (!consent?.provider) {
    return null
  }

  return {
    consentId: consumed.consent_id as string,
    provider: consent.provider as ProviderName,
    userId: typeof consumed.user_id === 'string' ? consumed.user_id : null,
    origin: typeof consumed.origin === 'string' ? consumed.origin : null,
  }
}

/** Encrypt provider credentials and error text during the two-minute handoff. */
export async function mintHandoff(
  consentId: string,
  userId: string,
  origin: string,
  result: { providerCode: string; providerError?: never } | { providerCode?: never; providerError: string },
): Promise<OtcResponse> {
  const code = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString()
  const { error } = await createServiceClient()
    .from('provider_otc')
    .insert({
      code,
      consent_id: consentId,
      user_id: userId,
      origin,
      provider_code: result.providerCode === undefined ? null : encryptHandoffValue(
        result.providerCode, JSON.stringify([code, consentId, userId, origin, 'provider_code']),
      ),
      provider_error: result.providerError === undefined ? null : encryptHandoffValue(
        result.providerError, JSON.stringify([code, consentId, userId, origin, 'provider_error']),
      ),
      expires_at: expiresAt,
    })
  if (error) throw new Error(`Failed to mint OAuth handoff: ${error.message}`)
  return { code, consentId, expiresAt }
}

/** Atomic DELETE RETURNING: only this origin can claim an unexpired handoff. */
export async function consumeHandoff(code: string, origin: string): Promise<{
  consentId: string
  provider: ProviderName
  userId: string | null
  origin: string
  providerCode: string | null
  providerError: string | null
} | null> {
  const supabase = createServiceClient()
  const { data: consumed, error } = await supabase
    .from('provider_otc')
    .delete()
    .eq('code', code)
    .eq('origin', origin)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .or('provider_code.not.is.null,provider_error.not.is.null')
    .select('consent_id, user_id, origin, provider_code, provider_error')
    .maybeSingle()
  if (error || !consumed?.consent_id) return null

  const { data: consent } = await supabase
    .from('provider_consents')
    .select('provider')
    .eq('id', consumed.consent_id)
    .maybeSingle()
  if (!consent?.provider) return null

  try {
    const decrypt = (column: 'provider_code' | 'provider_error') => consumed[column] === null
      ? null
      : decryptHandoffValue(consumed[column], JSON.stringify([
        code, consumed.consent_id, consumed.user_id, consumed.origin, column,
      ]))
    return {
      consentId: consumed.consent_id as string,
      provider: consent.provider as ProviderName,
      userId: typeof consumed.user_id === 'string' ? consumed.user_id : null,
      origin: consumed.origin as string,
      providerCode: decrypt('provider_code'),
      providerError: decrypt('provider_error'),
    }
  } catch {
    // The row has already been deleted. Tampered or unreadable credentials
    // have the same rejection as an unknown/expired handoff, without leaks.
    return null
  }
}

// ── OAuth helpers (direct provider calls) ───────────────────────────

export async function getAuthUrl(
  provider: ProviderName,
  state?: string,
  redirectUri?: string,
  /**
   * Ask Fortnox for the voucher-attachment scopes as well. Opt-in, so only a
   * user who wants their underlag is put in front of the extra permissions
   * (and their licence requirements).
   */
  options?: { documentScopes?: boolean },
): Promise<{ url: string }> {
  const config = getOAuthConfig(provider)

  // Override redirect URI if provided (extension callback URL)
  const effectiveConfig = redirectUri
    ? { ...config, redirectUri }
    : config

  if (provider === 'fortnox') {
    const url = buildFortnoxAuthUrl(effectiveConfig, {
      state,
      scopes: fortnoxConsentScopes({ documents: options?.documentScopes }),
    })
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

  // The code is spent and the tokens are valid, but nothing so far ties the
  // provider account they open to the Accounted company this consent belongs
  // to: the user (or someone who lured them) may have signed in to a different
  // Fortnox/Visma company. Same guard as Bokio/WINT in submitProviderToken:
  // refuse BEFORE anything is stored, so a foreign ledger never gets imported.
  await assertProviderCompanyMatchesConsent(supabase, consentId, provider, tokenResponse.access_token)

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

/**
 * Compare the org number of the company the freshly issued token opens with
 * the org number of the Accounted company that owns the consent.
 *
 * Only a confident mismatch blocks (throws ProviderCompanyMismatchError). A
 * missing org number on either side is not evidence of anything: Accounted
 * allows companies without one, a provider response can omit it, and the
 * company-information call itself can fail for reasons unrelated to identity
 * (scope not granted on this app registration, provider hiccup). Those cases
 * fall through and the connect completes exactly as before.
 */
async function assertProviderCompanyMatchesConsent(
  supabase: ReturnType<typeof createServiceClient>,
  consentId: string,
  provider: ProviderName,
  accessToken: string,
): Promise<void> {
  let info: CompanyInformationDto | null
  try {
    info = await fetchCompanyInfoDirect(provider, accessToken)
  } catch (error) {
    log.warn('provider company information unavailable after OAuth exchange; org-number check skipped', {
      provider,
      consentId,
      reason: error instanceof Error ? error.message : 'unknown',
    })
    return
  }

  const providerOrgNumber = normalizeOrgNumber(info?.organizationNumber)
  if (!providerOrgNumber) return

  const { data: consent } = await supabase
    .from('provider_consents')
    .select('company_id')
    .eq('id', consentId)
    .maybeSingle()
  if (!consent?.company_id) return

  const { data: targetCompany } = await supabase
    .from('companies')
    .select('org_number')
    .eq('id', consent.company_id as string)
    .maybeSingle()
  const targetOrgNumber = normalizeOrgNumber(targetCompany?.org_number)

  if (targetOrgNumber && providerOrgNumber !== targetOrgNumber) {
    throw new ProviderCompanyMismatchError(
      targetOrgNumber,
      providerOrgNumber,
      info?.companyName?.trim() || null,
    )
  }
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
  // What lands in provider_consent_tokens.provider_company_id. Usually the
  // caller-supplied value (BL User-Key, Bokio GUID, Briox account id); WINT
  // overrides it below because its caller-supplied value is the login mail,
  // which must not be persisted.
  let storedProviderCompanyId: string | undefined = providerCompanyId

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

  // Bokio: the pasted integration token is scoped to ONE Bokio company, and the
  // company GUID is typed in by hand. Nothing upstream ties either to the
  // Accounted company being imported into, so a token/GUID for the user's other
  // company imports that company's customers, suppliers and invoices here with
  // no error at all. Probe the documented company-information endpoint before
  // storing anything: it proves the credentials work and returns the
  // organizationNumber to compare.
  if (provider === 'bokio') {
    const bokioCompanyId = providerCompanyId?.trim() ?? ''
    accessToken = normalizeBokioAccessToken(apiToken)

    if (!accessToken) {
      throw new ProviderTokenInvalidError('Bokio requires an integration token')
    }
    if (!bokioCompanyId) {
      throw new ProviderTokenInvalidError(
        'Bokio requires a company id',
        'company-not-found',
      )
    }
    storedProviderCompanyId = bokioCompanyId

    let bokioCompany: Record<string, unknown> | null
    try {
      bokioCompany = await bokioClient.getCompany<Record<string, unknown>>(
        accessToken,
        bokioCompanyId,
      )
    } catch (error) {
      if (error instanceof BokioApiError) {
        // Only 401/403 are authentication verdicts. A 404 from the documented
        // company-information endpoint means the company id is unknown or is
        // not available to this company-scoped token. Other statuses can be a
        // provider/API failure and must not be blamed on the pasted token.
        if (error.statusCode === 401 || error.statusCode === 403) {
          throw new ProviderTokenInvalidError(
            `Bokio rejected the integration token (HTTP ${error.statusCode})`,
          )
        }
      }
      throw error
    }

    // getCompany() maps 404 to null: an unknown GUID is a bad company id, not
    // an outage.
    if (!bokioCompany) {
      throw new ProviderTokenInvalidError(
        'Bokio does not know that company id',
        'company-not-found',
      )
    }

    const bokioName = typeof bokioCompany['name'] === 'string'
      ? (bokioCompany['name'] as string).trim()
      : ''
    const bokioOrgNumber = normalizeOrgNumber(
      bokioCompany['organizationNumber'] as string | undefined,
    )

    const { data: targetCompany } = await supabase
      .from('companies')
      .select('org_number')
      .eq('id', ownerCompanyId)
      .maybeSingle()
    const targetOrgNumber = normalizeOrgNumber(targetCompany?.org_number)

    // Only a confident mismatch blocks. A missing org number on either side is
    // not evidence of anything (Accounted allows companies without one, and a
    // Bokio response could omit it), so those fall through to the labelling
    // below: the wizard still shows WHICH Bokio company was linked, which is
    // what lets the user catch it themselves.
    if (bokioOrgNumber && targetOrgNumber && bokioOrgNumber !== targetOrgNumber) {
      throw new ProviderCompanyMismatchError(
        targetOrgNumber,
        bokioOrgNumber,
        bokioName || null,
      )
    }

    // Label the consent with what the credentials actually opened. Written as
    // an object literal (not a conditional spread) so the phantom-column guard
    // can see which columns this touches. `undefined` is dropped by the JSON
    // serialisation, so a field Bokio did not return is left alone rather than
    // overwriting a value the user typed at connect time with null.
    if (bokioName || bokioOrgNumber) {
      await supabase
        .from('provider_consents')
        .update({
          company_name: bokioName || undefined,
          org_number: bokioOrgNumber || undefined,
        })
        .eq('id', consentId)
    }
  }

  // WINT: no API keys exist, so the wizard sends the user's WINT login
  // (providerCompanyId = mail, apiToken = password). The pair is exchanged
  // HERE, once, for an access/refresh token pair; the password is used for
  // this single call and never stored, logged, or echoed. The token is then
  // probed against GET /api/Auth to learn WHICH company it opens, mirroring
  // the Bokio org-number mismatch guard.
  if (provider === 'wint') {
    const mail = providerCompanyId?.trim()
    if (!mail || !mail.includes('@')) {
      throw new ProviderTokenInvalidError('WINT requires the login e-mail address')
    }

    try {
      const tokenResponse = await loginWint(mail, apiToken)
      accessToken = tokenResponse.access_token
      refreshToken = tokenResponse.refresh_token || null
      tokenExpiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
    } catch (error) {
      // A definitive LoginState (wrong password, locked, BankID-only) is a
      // credential verdict. Auth-endpoint 400/401/403 likewise. 429/5xx are
      // transient: rethrow as a generic submit failure.
      if (error instanceof WintLoginRejectedError) {
        throw new ProviderTokenInvalidError(`WINT rejected the login (${error.state})`)
      }
      if (error instanceof WintApiError && error.statusCode < 500 && error.statusCode !== 429) {
        throw new ProviderTokenInvalidError(`WINT rejected the login (HTTP ${error.statusCode})`)
      }
      throw error
    }

    const wintCompany = await wintClient.get<Record<string, unknown>>(accessToken, '/api/Auth')
    const wintCompanyName = typeof wintCompany['Name'] === 'string' ? (wintCompany['Name'] as string).trim() : ''
    const wintOrgNumber = normalizeOrgNumber(wintCompany['Org'] as string | undefined)

    const { data: targetCompany } = await supabase
      .from('companies')
      .select('org_number')
      .eq('id', ownerCompanyId)
      .maybeSingle()
    const targetOrgNumber = normalizeOrgNumber(targetCompany?.org_number)

    // Same confident-mismatch-only rule as Bokio: a missing org number on
    // either side falls through to labelling, a definite mismatch blocks.
    if (wintOrgNumber && targetOrgNumber && wintOrgNumber !== targetOrgNumber) {
      throw new ProviderCompanyMismatchError(targetOrgNumber, wintOrgNumber, wintCompanyName || null)
    }

    // The WINT-internal company id is what later calls may need (CompanyAuth
    // company switching); the login mail is deliberately NOT persisted.
    storedProviderCompanyId = wintCompany['Id'] != null ? String(wintCompany['Id']) : undefined

    if (wintCompanyName || wintOrgNumber) {
      await supabase
        .from('provider_consents')
        .update({
          company_name: wintCompanyName || undefined,
          org_number: wintOrgNumber || undefined,
        })
        .eq('id', consentId)
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
      provider_company_id: storedProviderCompanyId,
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
