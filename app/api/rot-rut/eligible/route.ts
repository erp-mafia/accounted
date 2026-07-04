import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { listRotRutCandidates } from '@/lib/invoices/rot-rut-service'

/**
 * GET /api/rot-rut/eligible?type=rot|rut
 *
 * Lists paid invoices carrying a ROT/RUT claim that are NOT yet part of an
 * active begäran om utbetalning, split into:
 *   - eligible: ready for file generation (with the amounts the file will use)
 *   - blocked:  excluded, with the exact blocker (same evaluation as the
 *               generator: what this endpoint approves, the file accepts)
 */
export const GET = withRouteContext('rot_rut.eligible', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx

  const { searchParams } = new URL(request.url)
  const typeParam = searchParams.get('type')
  const type = typeParam === 'rut' ? 'rut' : 'rot'

  const result = await listRotRutCandidates(supabase, companyId!, type)
  if (!result.ok) {
    log.error('failed to list rot/rut candidates', result.dbError as Error)
    return errorResponse(result.dbError, log, { requestId })
  }

  return NextResponse.json({
    data: { type, eligible: result.eligible, blocked: result.blocked },
  })
})
