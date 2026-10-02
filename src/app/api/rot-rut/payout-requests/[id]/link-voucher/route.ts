import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { RotRutLinkVoucherSchema } from '@/lib/api/schemas'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  linkRotRutPayoutVoucher,
  listRotRutPayoutVoucherCandidates,
} from '@/lib/invoices/rot-rut-link-voucher'

/**
 * GET /api/rot-rut/payout-requests/[id]/link-voucher
 *
 * Verifikat the begäran could be linked to: posted, unreversed, crediting
 * 1513, dated on or after the begäran was created, not already settling
 * another begäran.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'rot_rut.requests.link_voucher_candidates',
  async (_request, ctx, { params }) => {
    const { supabase, companyId, log, requestId } = ctx
    const { id } = await params

    const { data: payoutRequest, error: fetchError } = await supabase
      .from('rot_rut_payout_requests')
      .select('id, created_at')
      .eq('company_id', companyId!)
      .eq('id', id)
      .maybeSingle()
    if (fetchError) return errorResponse(fetchError, log, { requestId })
    if (!payoutRequest) return errorResponseFromCode('ROT_RUT_REQUEST_NOT_FOUND', log, { requestId })

    const { data, error } = await listRotRutPayoutVoucherCandidates(
      supabase,
      companyId!,
      String(payoutRequest.created_at).slice(0, 10),
    )
    if (error) return errorResponse(error, log, { requestId })

    return NextResponse.json({ data })
  },
)

/**
 * POST /api/rot-rut/payout-requests/[id]/link-voucher
 *
 * Links the begäran (and any request_ids the same transfer paid) to a payout
 * verifikat that already exists. Books nothing: see
 * lib/invoices/rot-rut-link-voucher.ts and the link_rot_rut_payout_voucher
 * RPC for every rule. dry_run checks without writing.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'rot_rut.requests.link_voucher',
  async (request, ctx, { params }) => {
    const { user, supabase, companyId, log, requestId } = ctx
    const { id } = await params

    const validation = await validateBody(request, RotRutLinkVoucherSchema)
    if (!validation.success) return validation.response
    const input = validation.data

    const outcome = await linkRotRutPayoutVoucher(supabase, companyId!, {
      requestIds: [...new Set([id, ...(input.request_ids ?? [])])],
      journalEntryId: input.journal_entry_id,
      dryRun: input.dry_run,
    })

    if (!outcome.ok) {
      if (outcome.kind === 'code') {
        return errorResponseFromCode(outcome.code, log, { requestId, details: outcome.details })
      }
      log.error('rot/rut payout voucher link failed', outcome.error as Error)
      return errorResponse(outcome.error, log, { requestId })
    }

    if (!outcome.result.dry_run) {
      log.info('rot/rut payout voucher linked', {
        userId: user.id,
        payoutRequestId: id,
        journalEntryId: input.journal_entry_id,
        alreadyLinked: outcome.result.already_linked,
      })
    }

    return NextResponse.json({ data: outcome.result })
  },
  { requireWrite: true },
)
