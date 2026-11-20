import { NextResponse } from 'next/server'
import type { RouteContext } from '@/lib/api/with-route-context'
import { capabilityBlockedResponse } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createServiceClient } from '@/lib/supabase/server'
import { loadCollectionsGateFacts } from './availability'
import { loadLiveConnection } from './connection'
import { collectionsErrorMessage, providerDisplayName } from './errors'
import type { CollectionsEnv } from './flags'
import { collectionsErrorResponse } from './responses'
import { hasCollectionsWording, type CollectionsRefusal, type CollectionsServiceDeps } from './service-deps'
import { routeActor } from './settings-routes'

/**
 * Shared plumbing for the invoice collection routes
 * (/api/invoices/[id]/collection and .../actions): the service's
 * dependencies for a person in the dashboard, and the answer to a refusal.
 * Server only.
 */

/** The case services' dependencies for a person in the web UI: attestations are theirs to give. */
export async function webCaseServiceDeps(ctx: RouteContext, env: CollectionsEnv): Promise<CollectionsServiceDeps> {
  const facts = await loadCollectionsGateFacts(ctx.supabase, ctx.companyId)
  return {
    db: createServiceClient(),
    companyId: ctx.companyId,
    actor: (({ userId, name }) => ({ userId, name }))(routeActor(ctx.user)),
    channel: 'web',
    facts,
    env,
    log: ctx.log,
  }
}

/** The provider's name for the sentences: the connection row's (the catalogue's at activation), else the neutral word. */
async function providerNameFor(ctx: RouteContext): Promise<string> {
  try {
    const connection = await loadLiveConnection(createServiceClient(), ctx.companyId)
    return providerDisplayName({ connectionName: connection?.display_name ?? null })
  } catch {
    return providerDisplayName({})
  }
}

/**
 * The answer to a refusal: the paywall envelope for a missing capability,
 * the provider's own failure worded with its name, collections codes with
 * the name filled in, and the registry's sentence for anything else.
 */
export async function caseRefusalResponse(refusal: CollectionsRefusal, ctx: RouteContext): Promise<NextResponse> {
  if (refusal.code === 'CAPABILITY_REQUIRED') return capabilityBlockedResponse(CAPABILITY.collections)
  if (refusal.upstream) {
    return collectionsErrorResponse(refusal.upstream, ctx.log, { provider: await providerNameFor(ctx), requestId: ctx.requestId })
  }
  if (hasCollectionsWording(refusal.code)) {
    const provider = await providerNameFor(ctx)
    return errorResponseFromCode(refusal.code, ctx.log, {
      requestId: ctx.requestId,
      status: refusal.status,
      messageSv: collectionsErrorMessage(refusal.code, { provider, locale: 'sv' }),
      messageEn: collectionsErrorMessage(refusal.code, { provider, locale: 'en' }),
      details: refusal.details,
    })
  }
  return errorResponseFromCode(refusal.code, ctx.log, { requestId: ctx.requestId, status: refusal.status, details: refusal.details })
}
