import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { RotRutBeslutFileSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { importRotRutBeslutFile } from '@/lib/invoices/rot-rut-beslut-import'

/**
 * POST /api/rot-rut/beslut/import
 *
 * Import Skatteverkets beslutsfil (the decision JSON downloaded from the
 * rot/rut e-tjänst) and record godkänt belopp on the matching payout
 * requests: per-item decided_amount, request decided_total/decided_at, the
 * SKV referensnummer, and the rejected status for 0-kr avslag.
 *
 * The body is the beslutsfil content verbatim. Matching is exact-only and
 * each beslut applies all-or-nothing; unmatched beslut are reported per
 * entry in the response instead of failing the whole import. Booking the
 * actual utbetalning stays with POST /payout-requests/{id}/settle.
 */
export const POST = withRouteContext(
  'rot_rut.beslut.import',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, RotRutBeslutFileSchema)
    if (!validation.success) return validation.response

    const result = await importRotRutBeslutFile(supabase, companyId!, validation.data)

    if (!result.ok) {
      return errorResponseFromCode(result.code, log, { requestId })
    }

    log.info('rot/rut beslutsfil imported', {
      imported: result.imported,
      alreadyImported: result.already_imported,
      errors: result.errors,
    })

    return NextResponse.json({ data: result })
  },
  { requireWrite: true },
)
