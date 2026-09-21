import { ProviderCallError } from '../with-provider-call'
import { FortnoxApiError, fortnoxApiErrorCode } from './client'

export type CompletionBlockReason = 'PROVIDER_AUTH_EXPIRED' | 'PROVIDER_LICENSE_MISSING' | 'PROVIDER_RESOURCE_FORBIDDEN'

/** Only explicit evidence may suspend scheduled work. An opaque 401/403 is insufficient. */
export function fortnoxCompletionBlock(error: unknown): CompletionBlockReason | null {
  if (error instanceof ProviderCallError && error.provider === 'fortnox') {
    if (error.code === 'PROVIDER_AUTH_EXPIRED' && ['invalid_grant', 'refresh_token_missing'].includes(error.providerCode ?? '')) return error.code
    if (error.code === 'PROVIDER_LICENSE_MISSING' && ['error_missing_license', 'error_missing_app_license'].includes(error.providerCode ?? '')) return error.code
  }
  if (error instanceof FortnoxApiError && error.statusCode < 500 && error.statusCode !== 429) {
    const code = fortnoxApiErrorCode(error)
    if (code === '2001103') return 'PROVIDER_LICENSE_MISSING'
    if (code === '2001101' || code === '2000663') return 'PROVIDER_RESOURCE_FORBIDDEN'
  }
  return null
}

export function fortnoxCompletionRetrySeconds(error: unknown): number {
  const seconds = error instanceof ProviderCallError ? error.retryAfterSeconds
    : error instanceof FortnoxApiError && error.retryAfterMs !== undefined ? error.retryAfterMs / 1000 : undefined
  return seconds !== undefined && Number.isFinite(seconds) ? Math.max(3600, Math.min(2_147_483_647, Math.ceil(seconds))) : 3600
}
