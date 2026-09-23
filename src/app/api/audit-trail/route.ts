import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { AuditTrailQuerySchema } from '@/lib/api/schemas'
import { getAuditLog } from '@/lib/core/audit/audit-service'

// GET /api/audit-trail — paginated audit log for the active company.
// The audit log is written exclusively by SECURITY DEFINER triggers; this
// endpoint is read-only.
export const GET = withRouteContext(
  'audit_trail.list',
  async (request, ctx) => {
    const { supabase, companyId, log } = ctx

    const query = validateQuery(request, AuditTrailQuerySchema, {
      log,
      operation: 'audit_trail.list',
    })
    if (!query.success) return query.response
    const { page, page_size, ...filters } = query.data

    const result = await getAuditLog(supabase, companyId, {
      ...filters,
      page,
      pageSize: page_size,
    })

    return NextResponse.json({ data: result.data, count: result.count })
  },
)
