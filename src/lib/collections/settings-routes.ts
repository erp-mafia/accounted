import { NextResponse } from 'next/server'
import type { RouteContext } from '@/lib/api/with-route-context'
import { createServiceClient } from '@/lib/supabase/server'
import { loadCollectionsGateFacts } from './availability'
import { ActivationValidationError, type ConnectionActor, type ConnectionServiceDeps } from './connection-service'
import { connectionView, loadLiveConnection, type CollectionConnectionRow } from './connection'
import { isCollectionsError } from './errors'
import { collectionsGate, readCollectionsEnv, type CollectionsPath, type CollectionsEnv } from './flags'
import { collectionsErrorResponse, collectionsGateResponse } from './responses'

/**
 * Shared plumbing for the /api/settings/collections routes: the gate, the
 * service's dependencies, and the answers. Server only.
 */

export function routeActor(user: RouteContext['user']): ConnectionActor {
  const metadata = (user.user_metadata ?? {}) as { full_name?: unknown; name?: unknown }
  const fullName = typeof metadata.full_name === 'string' ? metadata.full_name : typeof metadata.name === 'string' ? metadata.name : ''
  return { userId: user.id, name: fullName.trim() || user.email || user.id, email: user.email ?? null }
}

export function routeServiceDeps(ctx: RouteContext, env: CollectionsEnv = readCollectionsEnv()): ConnectionServiceDeps {
  return { db: createServiceClient(), companyId: ctx.companyId, actor: routeActor(ctx.user), env }
}

/**
 * The start gate for a path (flags.ts), or null when it may run. Reads the
 * company's facts with the caller's own client, so a member sees what RLS
 * lets them see.
 */
export async function collectionsRouteGate(ctx: RouteContext, path: CollectionsPath, env: CollectionsEnv): Promise<NextResponse | null> {
  const facts = await loadCollectionsGateFacts(ctx.supabase, ctx.companyId)
  const decision = collectionsGate(path, facts, env)
  return decision.allowed ? null : collectionsGateResponse(decision, ctx.log, ctx.requestId)
}

/** `{ data: { connection } }`: the view, never the provider's handle. */
export function connectionResponse(row: CollectionConnectionRow | null, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ data: { connection: row ? connectionView(row) : null, ...extra } }, { headers: { 'Cache-Control': 'no-store' } })
}

/**
 * The answer to a failed connection action: field errors as a validation
 * envelope (keys the browser words), a collections or provider failure with
 * the provider's name filled in. Anything else is rethrown for
 * withRouteContext's 500.
 */
export async function connectionErrorResponse(error: unknown, ctx: RouteContext): Promise<NextResponse> {
  if (error instanceof ActivationValidationError) {
    const errors = Object.entries(error.errors).map(([field, message]) => ({ field, message, code: 'custom' }))
    return NextResponse.json({ error: 'Validation failed', type: 'validation_error', errors }, { status: 400 })
  }
  if (isCollectionsError(error)) {
    let provider: string | null = null
    try {
      provider = (await loadLiveConnection(createServiceClient(), ctx.companyId))?.display_name ?? null
    } catch {
      provider = null
    }
    return collectionsErrorResponse(error, ctx.log, { provider, requestId: ctx.requestId })
  }
  throw error
}
