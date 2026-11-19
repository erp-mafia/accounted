/**
 * Call a posting or rättelse RPC with the commit actor of the current scope.
 *
 * The database records WHO acted (journal_entries.committed_actor_*,
 * journal_entry_rattelse_log.actor_type / actor_label and the audit_log rows
 * the same transaction writes) only when the RPC is handed the actor: the
 * user, API key, OAuth client, cron job or assistant that the surrounding
 * runWithActor() scope names (actor-context.ts). The RPCs that take it do so
 * through two defaulted parameters, p_actor_type and p_actor_label.
 *
 * Migrations reach production through a CI job after the merge, which can
 * land minutes after the Vercel deploy of the same change. A deploy that
 * arrives first meets the old signature, and PostgREST answers PGRST202 (no
 * function with these parameter names). This retries once without the two
 * parameters, so the write goes through unattributed, as before, instead of
 * failing. Without an actor the parameters are not sent at all.
 *
 * Isomorphic like actor-context.ts: engine.ts imports it and is reachable
 * from client bundles.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getActor, type CommitActor } from '@/lib/bookkeeping/actor-context'
import { createLogger } from '@/lib/logger'

const log = createLogger('bookkeeping.actor-rpc')

export interface ActorRpcParams {
  p_actor_type: CommitActor['type']
  p_actor_label: string | null
}

/** The two RPC parameters for an actor, or null when there is none to record. */
export function actorRpcParams(actor: CommitActor | undefined): ActorRpcParams | null {
  if (!actor) return null
  return { p_actor_type: actor.type, p_actor_label: actor.label ?? null }
}

/**
 * True for "no function matches these parameters": PGRST202 from PostgREST,
 * 42883 (undefined_function) from Postgres when PostgREST's schema cache is
 * ahead of the database.
 */
export function isMissingRpcSignature(error: { code?: string } | null | undefined): boolean {
  return error?.code === 'PGRST202' || error?.code === '42883'
}

export interface RpcAnswer<T> {
  data: T | null
  error: { message: string; code?: string; details?: string; hint?: string } | null
}

/**
 * supabase.rpc(fn, params) plus the actor parameters, with the one retry
 * described above. `actor` defaults to the current runWithActor() scope.
 */
export async function rpcWithActor<T = unknown>(
  supabase: SupabaseClient,
  fn: string,
  params: Record<string, unknown>,
  actor: CommitActor | undefined = getActor(),
): Promise<RpcAnswer<T>> {
  const actorParams = actorRpcParams(actor)
  if (!actorParams) {
    const { data, error } = await supabase.rpc(fn, params)
    return { data: (data ?? null) as T | null, error }
  }

  const first = await supabase.rpc(fn, { ...params, ...actorParams })
  if (!isMissingRpcSignature(first.error)) {
    return { data: (first.data ?? null) as T | null, error: first.error }
  }

  log.warn('RPC without the actor parameters yet: retrying without them, the write records no actor', {
    operation: 'rpc_with_actor_fallback',
    rpc: fn,
    actorType: actorParams.p_actor_type,
    pgCode: first.error?.code,
  })
  const retry = await supabase.rpc(fn, params)
  return { data: (retry.data ?? null) as T | null, error: retry.error }
}
