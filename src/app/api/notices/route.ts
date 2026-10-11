import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getCompanyNotices } from '@/lib/notices'
import { ensureInitialized } from '@/lib/init'

// The notice predicates read the skatteverket ombud services through the
// extension registry (lib/skatteverket/ombud-access.ts), which only
// ensureInitialized() fills.
ensureInitialized()

/**
 * GET /api/notices: active degraded-state notices for the active company,
 * in priority order (lib/notices, the health sibling of /api/worklist/counts).
 *
 * Read-only; every predicate is one bounded query that soft-fails to null,
 * and per-user dismissals are already filtered out.
 *
 * Response: { data: { notices: Notice[] } }
 */
export const GET = withRouteContext('notices.list', async (_request, ctx) => {
  const { supabase, companyId, user } = ctx
  const notices = await getCompanyNotices(supabase, companyId, { userId: user.id })
  return NextResponse.json({ data: { notices } })
})
