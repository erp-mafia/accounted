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
  const offset = (page - 1) * pageSize

  const auditTable = supabase.from('audit_log')
  let query = (includeCount
    ? auditTable.select('*', { count: 'exact' })
    : auditTable.select('*'))
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + pageSize - 1)

  query = applyAuditFilters(query, filters)

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
  if (decoded) {
    query = query.or(`created_at.lt.${decoded.ts},and(created_at.eq.${decoded.ts},id.lt.${decoded.id})`)
  }
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
