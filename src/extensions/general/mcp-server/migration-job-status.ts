import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('mcp-server/migration-job-status')

/**
 * Where the company's latest migration job for a provider stands, read for
 * gnubok_connect_migration: the state the import page shows (migration_jobs)
 * and the per-resource counts beside it (provider_migration_counts). Agents
 * asked for a read of it: without one, a migration that stopped on records
 * needing review looked the same as one still running.
 *
 * Read directly, like migration-underlag-status.ts reads the underlag run, so
 * the MCP server does not depend on the migration extension being enabled.
 * The records themselves (names, amounts from the source system) stay on the
 * import page, where the user reviews them.
 *
 *   not_started  no job for this provider
 *   unknown      the job could not be read
 *   otherwise    the job's own state: queued, running, retry_wait,
 *                needs_attention (records to review on the import page) or
 *                completed
 */
export type MigrationJobStatus =
  | { status: 'not_started' | 'unknown' }
  | {
      status: string
      phase: string
      error_code: string | null
      updated_at: string | null
      /** When a member accepted the finished job with the records that still need attention. */
      accepted_at: string | null
      /** Records per resource; null when the counts could not be read (never an empty list in their place). */
      resources: Array<{ resource: string; total: number; imported: number; needs_attention: number; pending: number; skipped: number }> | null
    }

function count(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

export async function migrationJobStatus(
  supabase: SupabaseClient,
  companyId: string,
  provider: string,
): Promise<MigrationJobStatus> {
  try {
    const { data: job, error } = await supabase
      .from('migration_jobs')
      .select('id, state, phase, error_code, updated_at, review_accepted_at')
      .eq('company_id', companyId)
      .eq('provider', provider)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) {
      log.warn('migration job not read', { companyId, code: error.code })
      return { status: 'unknown' }
    }
    const row = job as { id: string; state: string; phase: string; error_code: string | null; updated_at: string | null; review_accepted_at?: string | null } | null
    if (!row) return { status: 'not_started' }

    // The job was read with the company filter above, so its id is this company's.
    const { data: counts, error: countError } = await supabase.rpc('provider_migration_counts', { p_job_id: row.id })
    if (countError) log.warn('migration counts not read', { companyId, code: countError.code })
    const resources = countError ? null : ((Array.isArray(counts) ? counts : []) as Array<Record<string, unknown>>)
    return {
      status: row.state,
      phase: row.phase,
      error_code: row.error_code ?? null,
      updated_at: row.updated_at ?? null,
      accepted_at: row.review_accepted_at ?? null,
      resources: resources?.map((c) => ({
        resource: String(c.resource),
        total: count(c.total),
        imported: count(c.imported),
        needs_attention: count(c.needs_attention),
        pending: count(c.pending),
        skipped: count(c.skipped),
      })) ?? null,
    }
  } catch (error) {
    // The connect card must still render: the status is extra, never the point.
    log.warn('migration job not read', { companyId, reason: error instanceof Error ? error.message : 'unknown' })
    return { status: 'unknown' }
  }
}
