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
}

export const MIGRATION_PROVIDERS: readonly MigrationProviderInfo[] = [
  { id: 'fortnox', name: 'Fortnox', authType: 'oauth', sieViaApi: true },
  { id: 'visma', name: 'Visma', authType: 'oauth', sieViaApi: false },
  { id: 'bokio', name: 'Bokio', authType: 'token', sieViaApi: false },
  { id: 'bjornlunden', name: 'Björn Lundén', authType: 'token', sieViaApi: true },
  { id: 'briox', name: 'Briox', authType: 'token', sieViaApi: true },
  { id: 'wint', name: 'WINT', authType: 'token', sieViaApi: true },
]

/** The provider ids, in catalog order. */
export const MIGRATION_PROVIDER_IDS: readonly ProviderName[] = MIGRATION_PROVIDERS.map((p) => p.id)
