import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuditLogEntry, AuditAction } from '@/types'

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

  if (filters.action) {
    query = query.eq('action', filters.action)
  }
  if (filters.table_name) {
    query = query.eq('table_name', filters.table_name)
  }
  if (filters.record_id) {
    query = query.eq('record_id', filters.record_id)
  }
  if (filters.from_date) {
    query = query.gte('created_at', filters.from_date)
  }
  if (filters.to_date) {
    query = query.lte('created_at', filters.to_date)
  }

  const { data, error, count } = await query

  if (error) {
    throw new Error(`Failed to fetch audit log: ${error.message}`)
  }

  return {
    data: (data as AuditLogEntry[]) || [],
    count: includeCount ? count ?? 0 : 0,
  }
}
