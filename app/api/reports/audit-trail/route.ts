import { NextResponse } from 'next/server'
import { getAuditLog } from '@/lib/core/audit/audit-service'
import { withRouteContext } from '@/lib/api/with-route-context'
import type { AuditLogEntry, AuditAction } from '@/types'

const CSV_HEADERS = 'timestamp,action,table_name,record_id,description,old_state,new_state'

function escapeCSV(value: string | null | undefined): string {
  if (value == null) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function entryToCSVRow(entry: AuditLogEntry): string {
  return [
    escapeCSV(entry.created_at),
    escapeCSV(entry.action),
    escapeCSV(entry.table_name),
    escapeCSV(entry.record_id),
    escapeCSV(entry.description),
    escapeCSV(entry.old_state ? JSON.stringify(entry.old_state) : null),
    escapeCSV(entry.new_state ? JSON.stringify(entry.new_state) : null),
  ].join(',')
}

export const GET = withRouteContext('report.audit_trail', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const format = searchParams.get('format') || 'json'

  const filters = {
    action: (searchParams.get('action') as AuditAction) || undefined,
    table_name: searchParams.get('table_name') || undefined,
    record_id: searchParams.get('record_id') || undefined,
    from_date: searchParams.get('from_date') || undefined,
    to_date: searchParams.get('to_date') || undefined,
  }

  try {
    // Paginate through all matching entries
    const allEntries: AuditLogEntry[] = []
    let page = 1
    const pageSize = 500

    while (true) {
      const result = await getAuditLog(supabase, companyId, {
        ...filters,
        page,
        pageSize,
      })
      allEntries.push(...result.data)
      if (allEntries.length >= result.count || result.data.length < pageSize) {
        break
      }
      page++
    }

    if (format === 'csv') {
      const csvRows = [CSV_HEADERS, ...allEntries.map(entryToCSVRow)]
      const csvContent = csvRows.join('\n')

      return new NextResponse(csvContent, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="audit-trail.csv"',
        },
      })
    }

    // Default: JSON
    return new NextResponse(JSON.stringify({ data: allEntries, count: allEntries.length }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="audit-trail.json"',
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to generate audit trail report' },
      { status: 500 }
    )
  }
})
