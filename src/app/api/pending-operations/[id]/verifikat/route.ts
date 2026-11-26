import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { approvalVerifikat } from '@/lib/pending-operations/approval-verifikat'
import { verifikatBuiltAtApproval } from '@/lib/pending-operations/built-at-approval'

const ParamsSchema = z.object({ id: z.uuid() })

/**
 * GET /api/pending-operations/[id]/verifikat: the verifikat approving the
 * proposal would post, worked out now with the approval's own code, and
 * nothing written (lib/pending-operations/approval-verifikat.ts). For a
 * proposal whose rows are built at the click (verifikatBuiltAtApproval): the
 * card beside its Godkänn in Rutin asks for them when it opens. Never cached:
 * the answer follows the company's settings as they are now.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'pending_operation.verifikat',
  async (_request, ctx, { params }) => {
    const parsed = ParamsSchema.safeParse(await params)
    if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })

    const { data: op, error } = await ctx.supabase
      .from('pending_operations')
      .select('id, operation_type, status, params')
      .eq('id', parsed.data.id)
      .eq('company_id', ctx.companyId)
      .maybeSingle()
    if (error) throw error
    // Another company's proposal, or none, is not found; neither is one
    // whose staged preview states its rows itself.
    if (!op || !verifikatBuiltAtApproval(op)) {
      return errorResponseFromCode('PENDING_OPERATION_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }
    if (op.status !== 'pending') {
      return errorResponseFromCode('PENDING_OPERATION_NOT_PENDING', ctx.log, { requestId: ctx.requestId })
    }

    const answer = await approvalVerifikat(
      { supabase: ctx.supabase, companyId: ctx.companyId, userId: ctx.user.id, log: ctx.log },
      (op.params ?? {}) as Record<string, unknown>,
    )
    return NextResponse.json({ data: answer }, { headers: { 'Cache-Control': 'no-store' } })
  },
)
