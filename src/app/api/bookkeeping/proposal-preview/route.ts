/**
 * POST /api/bookkeeping/proposal-preview: the verifikat lines a booking
 * proposal posts, built by the code that posts them
 * (lib/bookkeeping/proposal-preview.ts). Read-only: a POST only because the
 * proposal travels as a body.
 */
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { ProposalPreviewSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { previewProposalLines } from '@/lib/bookkeeping/proposal-preview'

export const POST = withRouteContext('bookkeeping.proposal_preview', async (request, { supabase, companyId, log, requestId }) => {
  const validation = await validateBody(request, ProposalPreviewSchema, { log, operation: 'bookkeeping.proposal_preview' })
  if (!validation.success) return validation.response

  const outcome = await previewProposalLines({ supabase, companyId, log }, validation.data)
  if (!outcome.ok) {
    return errorResponseFromCode(outcome.code, log, {
      requestId,
      details: outcome.details,
      // Both locales or neither (errorResponseFromCode's contract).
      ...(outcome.message?.en ? { messageSv: outcome.message.sv, messageEn: outcome.message.en } : {}),
    })
  }
  return NextResponse.json({ data: { lines: outcome.lines } })
})
