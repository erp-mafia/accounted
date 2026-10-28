import { ProviderCallError } from '../with-provider-call'
import { fortnoxRefusal } from './client'

export type CompletionBlockReason = 'PROVIDER_AUTH_EXPIRED' | 'PROVIDER_LICENSE_MISSING' | 'PROVIDER_RESOURCE_FORBIDDEN'

/**
 * Only explicit evidence may suspend scheduled work. An opaque 401/403 is
 * insufficient, so a refusal blocks only when Fortnox named it with a code it
 * documents (fortnoxRefusal's `documented`).
 */
export function fortnoxCompletionBlock(error: unknown): CompletionBlockReason | null {
  if (error instanceof ProviderCallError && error.provider === 'fortnox') {
    if (error.code === 'PROVIDER_AUTH_EXPIRED' && ['invalid_grant', 'refresh_token_missing'].includes(error.providerCode ?? '')) return error.code
    if (error.code === 'PROVIDER_LICENSE_MISSING' && ['error_missing_license', 'error_missing_app_license'].includes(error.providerCode ?? '')) return error.code
  }
  const refusal = fortnoxRefusal(error)
  if (refusal?.documented) return refusal.reason === 'api_license' ? 'PROVIDER_LICENSE_MISSING' : 'PROVIDER_RESOURCE_FORBIDDEN'
  return null
}
