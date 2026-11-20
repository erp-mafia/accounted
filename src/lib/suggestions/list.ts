/**
 * The open suggestions a company is shown: at most three at a time, the
 * highest rank first (then the oldest), each one an open company_suggestions
 * row whose pending operation still waits. The rest wait their turn: they
 * stay pending (and on /pending) until one of the three is answered.
 *
 * Read by Att göra (the Förslag cards) and the agent briefing (the
 * `suggestions` list): the same records, so both show the same three.
 * Best-effort: a failed read, or a database without the table yet, is no
 * suggestions, never a broken page or briefing.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { SUGGESTION_OPERATION_TYPES, type OpenSuggestion } from './types'

const log = createLogger('suggestions')

/** At most this many open suggestions are shown at once. */
export const MAX_OPEN_SUGGESTIONS = 3

/** Open rows read before the pending check drops answered ones. */
const OPEN_ROW_SCAN = 20

interface SuggestionRow {
  id: string
  suggestion_key: string
  detector: string
  pending_operation_id: string | null
  created_at: string
}

interface OperationRow {
  id: string
  operation_type: string
  title: string
  preview_data: Record<string, unknown> | null
  params: Record<string, unknown> | null
}

export async function listOpenSuggestions(
  supabase: SupabaseClient,
  companyId: string,
  opts: { limit?: number } = {},
): Promise<OpenSuggestion[]> {
  const limit = opts.limit ?? MAX_OPEN_SUGGESTIONS
  try {
    const { data: rows, error } = await supabase
      .from('company_suggestions')
      .select('id, suggestion_key, detector, pending_operation_id, created_at')
      .eq('company_id', companyId)
      .eq('state', 'open')
      .order('rank', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(OPEN_ROW_SCAN)
    if (error) {
      log.warn('open suggestions could not be read', { companyId, error: error.message })
      return []
    }
    const suggestions = ((rows ?? []) as SuggestionRow[]).filter((r) => r.pending_operation_id)
    if (suggestions.length === 0) return []

    const { data: ops, error: opsError } = await supabase
      .from('pending_operations')
      .select('id, operation_type, title, preview_data, params')
      .eq('company_id', companyId)
      .eq('status', 'pending')
      .in('operation_type', [...SUGGESTION_OPERATION_TYPES])
      .in('id', suggestions.map((s) => s.pending_operation_id as string))
    if (opsError) {
      log.warn('open suggestions could not be read', { companyId, error: opsError.message })
      return []
    }
    const byId = new Map(((ops ?? []) as OperationRow[]).map((op) => [op.id, op]))

    const open: OpenSuggestion[] = []
    for (const s of suggestions) {
      const op = byId.get(s.pending_operation_id as string)
      if (!op) continue
      const packageId = op.params?.package_id
      const reason = op.preview_data?.reason
      open.push({
        suggestion_id: s.id,
        pending_operation_id: op.id,
        detector: s.detector,
        suggestion_key: s.suggestion_key,
        operation_type: op.operation_type,
        package_id: typeof packageId === 'string' ? packageId : null,
        title: op.title,
        reason: typeof reason === 'string' ? reason : null,
        created_at: s.created_at,
      })
      if (open.length >= limit) break
    }
    return open
  } catch (err) {
    log.warn('open suggestions could not be read', { companyId, error: err instanceof Error ? err.message : String(err) })
    return []
  }
}
