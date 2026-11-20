import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger, type Logger } from '@/lib/logger'
import { collectionsAdapterFor } from './adapters'
import { normalizeConnectionRow, type CollectionConnectionRow } from './connection'
import { COLLECTIONS_ERROR_MESSAGES, COLLECTIONS_UNAVAILABLE, CollectionsError } from './errors'
import { collectionsGate, type CollectionsEnv, type CollectionsGateFacts, type CollectionsPath } from './flags'
import type { CollectionsAdapter, CollectionsCallContext, CollectionsRoute } from './port'

/**
 * What the case services (open-case.ts, case-actions.ts) run with, and the
 * one shape their refusals take. Server only.
 */

export interface CollectionsActor {
  userId: string
  name: string
}

export interface CollectionsServiceDeps {
  /** Service-role client; every query filters on companyId. */
  db: SupabaseClient
  companyId: string
  actor: CollectionsActor
  /** 'web' = a person in the dashboard; 'agent' = MCP or the v1 API (no attestations, web-only approvals refused). */
  channel: 'web' | 'agent'
  /** The company's gate facts (flags.ts), read by the caller with the client it trusts. */
  facts: CollectionsGateFacts
  env: CollectionsEnv
  now?: () => Date
  adapterFor?: (connection: { route: CollectionsRoute }) => CollectionsAdapter | null
  log?: Logger
}

/** A refusal the service answers instead of acting. `code` is a structured-error registry code. */
export interface CollectionsRefusal {
  ok: false
  code: string
  status: number
  details?: Record<string, unknown>
  /** The provider's error when the refusal came from Connect (worded with the provider's name). */
  upstream?: CollectionsError
}

export function refusal(code: string, details?: Record<string, unknown>): CollectionsRefusal {
  const status = REFUSAL_STATUS[code] ?? 409
  return details ? { ok: false, code, status, details } : { ok: false, code, status }
}

const REFUSAL_STATUS: Record<string, number> = {
  COLLECTION_CASE_NOT_FOUND: 404,
  INVOICE_NOT_FOUND: 404,
  COLLECTION_ATTESTATION_WEB_ONLY: 403,
  COLLECTION_ACTION_MESSAGE_REQUIRED: 400,
  COLLECTION_PAUSE_UNTIL_INVALID: 400,
  COLLECTION_DOCUMENT_TOO_LARGE: 413,
  COLLECTIONS_CONNECTION_NOT_FOUND: 409,
  COLLECTIONS_UNAVAILABLE: 503,
}

/** The refusal for a gate decision that said no. CAPABILITY_REQUIRED is answered with the paywall envelope by the doors. */
export function gateRefusal(path: CollectionsPath, deps: Pick<CollectionsServiceDeps, 'facts' | 'env'>): CollectionsRefusal | null {
  const decision = collectionsGate(path, deps.facts, deps.env)
  if (decision.allowed) return null
  return { ok: false, code: decision.code, status: decision.status }
}

export function serviceLog(deps: Pick<CollectionsServiceDeps, 'log'>, scope: string): Logger {
  return deps.log ?? createLogger(scope)
}

export async function loadConnectionById(
  db: Pick<SupabaseClient, 'from'>,
  companyId: string,
  connectionId: string,
): Promise<CollectionConnectionRow | null> {
  const { data, error } = await db
    .from('collection_connections')
    .select('*')
    .eq('company_id', companyId)
    .eq('id', connectionId)
    .maybeSingle()
  if (error) throw new Error(`collection_connections lookup failed: ${error.message}`)
  return data ? normalizeConnectionRow(data as Record<string, unknown>) : null
}

/** The adapter for a connection's route; COLLECTIONS_UNAVAILABLE when this installation has none for it. */
export function adapterForConnection(
  deps: Pick<CollectionsServiceDeps, 'adapterFor'>,
  connection: Pick<CollectionConnectionRow, 'route'>,
): CollectionsAdapter {
  const adapter = (deps.adapterFor ?? collectionsAdapterFor)(connection)
  if (!adapter) {
    throw new CollectionsError('No collections adapter for this connection route on this installation', {
      code: COLLECTIONS_UNAVAILABLE,
      retryable: false,
    })
  }
  return adapter
}

export function callContext(companyId: string, connection: Pick<CollectionConnectionRow, 'connection_handle'>): CollectionsCallContext {
  return { companyId, connectionHandle: connection.connection_handle }
}

/** True when a code has collections wording (errors.ts), so a door can fill in the provider's name. */
export function hasCollectionsWording(code: string): boolean {
  return code in COLLECTIONS_ERROR_MESSAGES
}
