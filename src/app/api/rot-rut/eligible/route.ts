import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { listGronTeknikCandidates, listRotRutCandidates } from '@/lib/invoices/rot-rut-service'
import { ensureInitialized } from '@/lib/init'

ensureInitialized()

/**
 * GET /api/rot-rut/eligible?type=rot|rut|gron_teknik
 *
 * Lists deduction-carrying invoices for the begäran om utbetalning dialog,
 * split into:
 *   - eligible: ready to be requested (with the amounts the request will use)
 *   - blocked:  excluded, with the exact blocker (same evaluation as the
 *               generator: what this endpoint approves, the file accepts).
 *               Includes wrong-type ROT/RUT invoices (NO_DEDUCTION_OF_TYPE,
 *               pointing at the other list) and invoices held by an
 *               in-flight begäran (ALREADY_REQUESTED): nothing drops out
 *               silently (#1884).
 *   - other_type_counts: invoices whose deduction is requested in another
 *               e-tjänst (grön teknik on the ROT/RUT lists, ROT/RUT on the
 *               grön teknik list), counted rather than listed; each one is
 *               listed on its own kind's list.
 *
 * type=gron_teknik lists invoices for the request made in Skatteverkets
 * e-tjänst Grön teknik: företag (no file is generated for them yet). A
 * missing or unknown type reads as rot, as it always has.
 */
export const GET = withRouteContext('rot_rut.eligible', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx

  const { searchParams } = new URL(request.url)
  const typeParam = searchParams.get('type')
  const type = typeParam === 'rut' ? 'rut' : typeParam === 'gron_teknik' ? 'gron_teknik' : 'rot'

  const result =
    type === 'gron_teknik'
      ? await listGronTeknikCandidates(supabase, companyId!)
      : await listRotRutCandidates(supabase, companyId!, type)
  if (!result.ok) {
    log.error('failed to list rot/rut candidates', result.dbError as Error)
    return errorResponse(result.dbError, log, { requestId })
  }

  return NextResponse.json({
    data: {
      type,
      eligible: result.eligible,
      blocked: result.blocked,
      other_type_counts: result.other_type_counts,
    },
  })
})
