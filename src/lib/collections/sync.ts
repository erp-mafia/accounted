import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { refreshRow, type ConnectionServiceDeps } from './connection-service'
import { normalizeConnectionRow, type CollectionConnectionRow } from './connection'
import { readCollectionsEnv, type CollectionsEnv } from './flags'

const log = createLogger('collections/sync')

/**
 * The collections sync run (build spec 1.6), every ten minutes from
 * /api/collections/sync/cron. This version polls the connections whose
 * activation is under way; the change feed (cases, deliveries, settlements)
 * joins it when the case tables arrive.
 *
 * Polling is not start work: it only reads where an activation the company
 * already sent stands, so it runs whatever the start gates say. A failing
 * company never stops the run; its failure lands on its own row's health.
 */

/** Rows polled per run: far more than any realistic number of activations in review at once. */
export const SYNC_CONNECTION_BATCH = 200

export interface CollectionsSyncSummary {
  polled: number
  changed: number
  failed: number
}

export interface CollectionsSyncDeps {
  db: SupabaseClient
  env?: CollectionsEnv
  now?: () => Date
  /** Overrides the service's adapter lookup (tests). */
  adapterFor?: ConnectionServiceDeps['adapterFor']
}

export async function runCollectionsSync(deps: CollectionsSyncDeps): Promise<CollectionsSyncSummary> {
  const env = deps.env ?? readCollectionsEnv()
  const { data, error } = await deps.db
    .from('collection_connections')
    .select('*')
    .eq('state', 'connecting')
    .order('updated_at', { ascending: true })
    .limit(SYNC_CONNECTION_BATCH)
  if (error) throw new Error(`collection_connections poll failed: ${error.message}`)

  const rows = ((data ?? []) as Record<string, unknown>[]).map(normalizeConnectionRow)
  const due = rows.filter((row) => row.connection_handle !== null || row.submitted_at !== null)
  const summary: CollectionsSyncSummary = { polled: due.length, changed: 0, failed: 0 }
  let lastError: string | null = null

  for (const row of due) {
    try {
      const after = await refreshRow(
        { db: deps.db, companyId: row.company_id, actor: null, env, now: deps.now, adapterFor: deps.adapterFor },
        row,
      )
      if (changedState(row, after)) summary.changed++
    } catch (err) {
      summary.failed++
      lastError = err instanceof Error ? err.message : String(err)
      log.warn('collections connection poll failed', { connectionId: row.id, companyId: row.company_id, error: lastError })
    }
  }

  const now = (deps.now ? deps.now() : new Date()).toISOString()
  const { error: stateError } = await deps.db
    .from('collection_sync_state')
    .update({ last_run_at: now, last_error: lastError })
    .eq('id', 1)
  if (stateError) log.warn('collection_sync_state update failed', { error: stateError.message })
  return summary
}

function changedState(before: CollectionConnectionRow, after: CollectionConnectionRow): boolean {
  return before.state !== after.state || before.sub_status !== after.sub_status
}
