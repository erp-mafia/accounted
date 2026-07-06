import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { validateQuery } from '@/lib/api/validate'
import { PendingOperationsQuerySchema } from '@/lib/api/schemas'
import { requireCompanyId } from '@/lib/company/context'

/**
 * GET /api/pending-operations
 *
 * List pending operations for the authenticated user.
 * Query params: status (default: pending), limit, offset
 */
export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const result = validateQuery(request, PendingOperationsQuerySchema)
  if (!result.success) return result.response
  const { status, limit, offset } = result.data

  // Terminal tabs (Godkända/Avvisade) order by when the op was RESOLVED, not
  // created: auto-expired ops are ≥30 days old by construction, so a
  // created_at ordering would bury a fresh expiry sweep below a month of
  // newer rejections and the "Utgick automatiskt" context would never be seen.
  const orderColumn = status === 'pending' ? 'created_at' : 'resolved_at'

  const { data, error, count } = await supabase
    .from('pending_operations')
    .select('*', { count: 'exact' })
    .eq('company_id', companyId)
    .eq('status', status)
    .order(orderColumn, { ascending: false, nullsFirst: false })
    .range(offset, offset + limit - 1)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data: data ?? [], count })
}
