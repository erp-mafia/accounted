/**
 * The retag history of posted lines (dimension_retag_log): one immutable row
 * per changed line, written by the retag_line_dimensions RPC before it
 * touches the line, with the old and the new bag, who, when and why. The
 * log has no foreign keys to its lines, so it outlives an undone import:
 * a filter that matches no live entry still answers the history it holds.
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'

export interface RetagLogFilter {
  journal_entry_id?: string
  line_id?: string
  limit: number
  offset: number
}

export interface RetagLogEntry {
  retag_log_id: string
  journal_entry_id: string
  line_id: string
  old_dimensions: Record<string, string>
  new_dimensions: Record<string, string>
  actor: string | null
  reason: string
  created_at: string
}

export interface RetagLogPage {
  entries: RetagLogEntry[]
  count: number
  total_count: number
  has_more: boolean
  next_offset?: number
}

/** A page of the company's retag history, newest first. */
export async function listDimensionRetagLog(
  ctx: OperationContext,
  filter: RetagLogFilter,
): Promise<OperationOutcome<RetagLogPage>> {
  let query = ctx.supabase
    .from('dimension_retag_log')
    .select('id, journal_entry_id, line_id, old_dimensions, new_dimensions, actor, reason, created_at', {
      count: 'exact',
    })
    .eq('company_id', ctx.companyId)
  if (filter.journal_entry_id) query = query.eq('journal_entry_id', filter.journal_entry_id)
  if (filter.line_id) query = query.eq('line_id', filter.line_id)

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(filter.offset, filter.offset + filter.limit - 1)
  if (error) {
    ctx.log.error('dimension retag log read failed', error)
    return { ok: false, code: 'UNKNOWN_ERROR', error }
  }

  const entries = ((data ?? []) as Array<Omit<RetagLogEntry, 'retag_log_id'> & { id: string }>).map(
    ({ id, ...row }) => ({ retag_log_id: id, ...row }),
  )
  const total = count ?? filter.offset + entries.length
  const hasMore = filter.offset + entries.length < total
  return {
    ok: true,
    data: {
      entries,
      count: entries.length,
      total_count: total,
      has_more: hasMore,
      ...(hasMore ? { next_offset: filter.offset + entries.length } : {}),
    },
  }
}
