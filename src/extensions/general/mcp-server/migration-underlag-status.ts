import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('mcp-server/migration-underlag-status')

/**
 * Where a migration's underlag step stands, read for gnubok_connect_migration.
 *
 * The files behind each verifikat are fetched by a step of its own after the
 * bookkeeping import ("Hämta underlag" on the provider's row of the import
 * page), never by the migration itself. The step's latest run is one summary
 * per company in extension_data (arcim-migration/document_import_run, written
 * by that extension's document-import-run.ts). This reads it directly, as the
 * AGI status reads skatteverket's extension_data, so the MCP server does not
 * depend on the migration extension being enabled.
 *
 *   not_fetched      no run for this provider yet
 *   incomplete       a run that has not reached the end of the provider's list
 *                    (running, continuing on the server, or stopped)
 *   needs_reconnect  a run stopped until the provider connection is renewed
 *   complete         a run reached the end; left_out names what did not come
 *   unknown          the summary could not be read
 */
export type MigrationUnderlagStatus =
  | { status: 'not_fetched' | 'unknown' }
  | {
      status: 'incomplete' | 'needs_reconnect' | 'complete'
      updated_at: string | null
      on_verifikat: number
      total: number
      unmatched: number
      failed: number
      locked: number
      /** Sources the provider did not let through, as "scope:reason". */
      left_out: string[]
    }

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export async function migrationUnderlagStatus(
  supabase: SupabaseClient,
  companyId: string,
  provider: string,
): Promise<MigrationUnderlagStatus> {
  try {
    const { data, error } = await supabase
      .from('extension_data')
      .select('value')
      .eq('company_id', companyId)
      .eq('extension_id', 'arcim-migration')
      .eq('key', 'document_import_run')
      .maybeSingle()
    if (error) {
      log.warn('underlag run not read', { companyId, code: error.code })
      return { status: 'unknown' }
    }
    const run = (data as { value?: Record<string, unknown> } | null)?.value
    if (!run || typeof run !== 'object' || run.provider !== provider) return { status: 'not_fetched' }

    const unreachable = Array.isArray(run.unreachableSources) ? run.unreachableSources : []
    return {
      status: run.needsReconnect === true ? 'needs_reconnect' : run.complete === true ? 'complete' : 'incomplete',
      updated_at: typeof run.updatedAt === 'string' ? run.updatedAt : null,
      on_verifikat: count(run.linked) + count(run.skipped),
      total: count(run.total),
      unmatched: count(run.unmatched),
      failed: count(run.failed),
      locked: count(run.locked),
      left_out: unreachable
        .filter((entry): entry is { scope: string; reason: string } =>
          typeof entry?.scope === 'string' && typeof entry?.reason === 'string')
        .map((entry) => `${entry.scope}:${entry.reason}`),
    }
  } catch (error) {
    // The connect card must still render: the status is extra, never the point.
    log.warn('underlag run not read', { companyId, reason: error instanceof Error ? error.message : 'unknown' })
    return { status: 'unknown' }
  }
}
