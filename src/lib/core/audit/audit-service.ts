import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuditLogEntry, AuditAction } from '@/types'
import { decodeDefaultCursor, encodeDefaultCursor } from '@/lib/api/v1/pagination'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'

/**
 * Audit Service - Read-only service for the audit log
 *
 * The audit log is written exclusively by database triggers (SECURITY DEFINER).
 * This service provides read access for compliance reporting and investigation.
 */

export interface AuditLogFilters {
  action?: AuditAction
  table_name?: string
  record_id?: string
  from_date?: string
  to_date?: string
  page?: number
  pageSize?: number
  /** Full exports can skip the expensive exact count and stop on a short page. */
  includeCount?: boolean
  /**
   * Keyset cursor: only the rows after this one in the newest-first order,
   * and `page` is ignored. A reader that walks the whole log (the full
   * archive export) passes the last row it got; an OFFSET makes Postgres
   * fetch and discard every earlier row, which for a company with 570 000
   * audit rows took 16 s at offset 200 000, past the statement timeout.
   */
  after?: AuditLogCursor
}

/** A position in the newest-first (created_at, id) order: a row's own two values. */
export interface AuditLogCursor {
  created_at: string
  id: string
}

/**
 * Get paginated audit log entries for a company
 */
export async function getAuditLog(
  supabase: SupabaseClient,
  companyId: string,
  filters: AuditLogFilters = {}
): Promise<{ data: AuditLogEntry[]; count: number }> {
  const page = filters.page ?? 1
  const pageSize = filters.pageSize ?? 50
  const includeCount = filters.includeCount ?? true
  const offset = filters.after ? 0 : (page - 1) * pageSize

  const auditTable = supabase.from('audit_log')
  let query = (includeCount
    ? auditTable.select('*', { count: 'exact' })
    : auditTable.select('*'))
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + pageSize - 1)

  query = applyAuditFilters(query, filters)
  if (filters.after) query = applyAfterCursor(query, filters.after)

  const { data, error, count } = await query

  if (error) {
    throw new Error(`Failed to fetch audit log: ${error.message}`)
  }

  return {
    data: (data as AuditLogEntry[]) || [],
    count: includeCount ? count ?? 0 : 0,
  }
}

/**
 * The filters both readers share. to_date compares against the created_at
 * TIMESTAMP, so a bare date means that day's midnight (the dashboard's
 * long-standing behaviour, kept so the two doors agree).
 */
// The PostgREST builder's generic chain is too deep to thread through a
// helper (TS2589), so the helper takes and returns it untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AuditQuery = any

function applyAuditFilters(
  query: AuditQuery,
  filters: Pick<AuditLogFilters, 'action' | 'table_name' | 'record_id' | 'from_date' | 'to_date'>,
): AuditQuery {
  let q = query
  if (filters.action) q = q.eq('action', filters.action)
  if (filters.table_name) q = q.eq('table_name', filters.table_name)
  if (filters.record_id) q = q.eq('record_id', filters.record_id)
  if (filters.from_date) q = q.gte('created_at', filters.from_date)
  if (filters.to_date) q = q.lte('created_at', filters.to_date)
  return q
}

/**
 * Rows strictly after `cursor` in the (created_at DESC, id DESC) order. The
 * .or() alone is exact but no index bound: Postgres cannot start a btree
 * scan from an OR across two columns, so it walked
 * idx_audit_log_company_created_id from the company's newest row and
 * filtered every row before the cursor (187 ms and 200 000 buffers on page
 * 400 of the largest company). The redundant `created_at <= ts` is the
 * bound it can start from (1.6 ms, 544 buffers); the .or() then only drops
 * the rows that share the cursor's timestamp.
 */
function applyAfterCursor(query: AuditQuery, cursor: AuditLogCursor): AuditQuery {
  return query
    .lte('created_at', cursor.created_at)
    .or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`)
}

export interface AuditLogPageFilters
  extends Pick<AuditLogFilters, 'action' | 'table_name' | 'record_id' | 'from_date' | 'to_date'> {
  cursor?: string
  limit?: number
}

/**
 * One page of the company's audit log, newest first, keyset on
 * (created_at, id) descending, for the v1 door (GET /api/v1/.../audit-trail).
 * Same filters and order as getAuditLog; a cursor that does not decode starts
 * over (v1 convention). Read-only: the log is written only by triggers.
 */
export async function listAuditLogPage(
  ctx: OperationContext,
  filters: AuditLogPageFilters,
): Promise<OperationOutcome<{ entries: AuditLogEntry[]; next_cursor: string | null }>> {
  const limit = filters.limit ?? 50
  const decoded = decodeDefaultCursor(filters.cursor)
  let query = ctx.supabase
    .from('audit_log')
    .select('*')
    .eq('company_id', ctx.companyId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1)
  query = applyAuditFilters(query, filters)
  if (decoded) query = applyAfterCursor(query, { created_at: decoded.ts, id: decoded.id })
  const { data, error } = await query
  if (error) {
    ctx.log.error('audit log page read failed', error)
    return { ok: false, code: 'REPORT_GENERATION_FAILED' }
  }
  const rows = (data ?? []) as AuditLogEntry[]
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    ok: true,
    data: {
      entries: page,
      next_cursor: rows.length > limit && last ? encodeDefaultCursor(last) : null,
    },
  }
}
