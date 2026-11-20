import type { NextResponse } from 'next/server'
import { capabilityBlockedResponse } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { collectionsEnvelopeCode, collectionsErrorMessage, type CollectionsError } from './errors'
import type { CollectionsGateDecision } from './flags'

type Logger = Parameters<typeof errorResponseFromCode>[1]

/**
 * HTTP answers for collections and delivery routes (server only; errors.ts
 * stays free of next/server so the UI can share its words).
 */

/**
 * The answer to a refused start path: the paywall's own 403 envelope for a
 * missing capability (so the UI shows its UpgradeNote), the registry's
 * COLLECTIONS_DISABLED (503) or COLLECTIONS_NOT_ACTIVE (409) otherwise.
 */
export function collectionsGateResponse(
  decision: Extract<CollectionsGateDecision, { allowed: false }>,
  log: Logger,
  requestId?: string,
): NextResponse {
  if (decision.code === 'CAPABILITY_REQUIRED') return capabilityBlockedResponse(CAPABILITY.collections)
  return errorResponseFromCode(decision.code, log, { requestId, status: decision.status })
}

/**
 * The answer to a failed adapter call, worded for collections with the
 * provider's name filled in (the catalogue's, else the connection row's,
 * else the neutral word). The service's own code travels in details.
 */
export function collectionsErrorResponse(
  error: CollectionsError,
  log: Logger,
  options: { provider?: string | null; requestId?: string } = {},
): NextResponse {
  return errorResponseFromCode(collectionsEnvelopeCode(error.code), log, {
    requestId: options.requestId,
    messageSv: collectionsErrorMessage(error.code, { provider: options.provider, locale: 'sv' }),
    messageEn: collectionsErrorMessage(error.code, { provider: options.provider, locale: 'en' }),
    details: { upstream_code: error.code, retryable: error.retryable },
  })
}
