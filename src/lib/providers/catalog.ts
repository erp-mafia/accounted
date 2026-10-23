import type { ProviderName } from './types'

/**
 * The previous bookkeeping systems the migration wizard connects to, in the
 * order the wizard offers them. One list for the workspace, the extension and
 * the MCP connect card. `sieViaApi`: the provider serves its general ledger
 * as SIE over the API, so the wizard imports bookkeeping automatically: no
 * manual SIE upload needed.
 *
 * WINT's "token" is the user's WINT login exchanged once for a JWT pair (WINT
 * has no API keys or OAuth). It is env-gated server-side
 * (WINT_MIGRATION_ENABLED): the extension's GET /status names the providers
 * this deployment can connect.
 */
export interface MigrationProviderInfo {
  id: ProviderName
  name: string
  authType: 'oauth' | 'token'
  sieViaApi: boolean
  /** Token providers only: what the connect asks the customer for. */
  credentials?: TokenCredentials
}

/**
 * What a token provider's connect needs from the customer. One rule for the
 * server's /submit-token check and both connect forms (the Import page and
 * the books act), so a form never asks for more or less than the server
 * accepts: the books act once asked a Björn Lundén customer for an API key BL
 * never issues, and kept Anslut disabled until it was filled.
 *
 * `secret`: what the customer pastes for us to exchange: Bokio's integration
 * token, Briox's application token, the WINT password. Björn Lundén has
 * none: Accounted holds the client credentials and the customer only names
 * the company.
 * `companyId`: the provider-side company (BL User-Key, Bokio company id,
 * Briox account id) or, for WINT, the login e-mail.
 */
export interface TokenCredentials {
  secret: boolean
  companyId: boolean
}

export const MIGRATION_PROVIDERS: readonly MigrationProviderInfo[] = [
  { id: 'fortnox', name: 'Fortnox', authType: 'oauth', sieViaApi: true },
  { id: 'visma', name: 'Visma', authType: 'oauth', sieViaApi: false },
  { id: 'bokio', name: 'Bokio', authType: 'token', sieViaApi: false, credentials: { secret: true, companyId: true } },
  { id: 'bjornlunden', name: 'Björn Lundén', authType: 'token', sieViaApi: true, credentials: { secret: false, companyId: true } },
  { id: 'briox', name: 'Briox', authType: 'token', sieViaApi: true, credentials: { secret: true, companyId: true } },
  { id: 'wint', name: 'WINT', authType: 'token', sieViaApi: true, credentials: { secret: true, companyId: true } },
]

/** The provider ids, in catalog order. */
export const MIGRATION_PROVIDER_IDS: readonly ProviderName[] = MIGRATION_PROVIDERS.map((p) => p.id)

/**
 * The credentials `provider`'s connect needs. A provider without a
 * `credentials` entry (the OAuth ones) gets what /submit-token has always
 * demanded of them: a token, no company.
 */
export function tokenCredentials(provider: string): TokenCredentials {
  return MIGRATION_PROVIDERS.find((p) => p.id === provider)?.credentials ?? { secret: true, companyId: false }
}

/** The first credential still missing, or null when the connect can be submitted. */
export function missingTokenCredential(
  provider: string,
  input: { apiToken?: string | null; companyId?: string | null },
): keyof TokenCredentials | null {
  const needs = tokenCredentials(provider)
  if (needs.secret && !input.apiToken) return 'secret'
  if (needs.companyId && !input.companyId) return 'companyId'
  return null
}
