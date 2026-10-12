import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { RouteContext } from '@/lib/api/with-route-context'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { batchParamsSchema, COLLECTIONS_BATCH_TYPE, remainingBatchItems } from '@/lib/collections/batch'
import { loadBatchRemovals } from '@/lib/collections/batch-removals'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

const ParamsSchema = z.object({ id: z.uuid() })

const NarrowBodySchema = z.object({
  /** The invoices to take out of the batch. Removal only: nothing can be added here. */
  remove_invoice_ids: z.array(z.uuid()).min(1).max(500),
})

/** The batch as the review dialog shows it: the staged items less the removed ones, the excluded, the removals. */
async function batchView(ctx: RouteContext, operationId: string): Promise<NextResponse> {
  const { data: op, error } = await ctx.supabase
    .from('pending_operations')
    .select('id, operation_type, status, params, created_at')
    .eq('id', operationId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (error) throw error
  if (!op || op.operation_type !== COLLECTIONS_BATCH_TYPE) {
    return errorResponseFromCode('COLLECTION_BATCH_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
  }
  const params = batchParamsSchema.safeParse(op.params)
  if (!params.success) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
  const removals = await loadBatchRemovals(ctx.supabase, ctx.companyId, operationId)
  return NextResponse.json({
    data: {
      id: op.id,
      status: op.status,
      created_at: op.created_at,
      batch_date: params.data.batch_date,
      items: remainingBatchItems(params.data, removals),
      excluded: params.data.excluded,
      removed: removals,
    },
  })
}

/**
 * GET /api/pending-operations/[id]/items: a daily collections batch as the
 * review dialog shows it.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'pending_operation.batch_items',
  async (_request, ctx, { params }) => {
    const parsed = ParamsSchema.safeParse(await params)
    if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
    return batchView(ctx, parsed.data.id)
  },
)

const RPC_ERRORS = ['COLLECTION_BATCH_NOT_FOUND', 'COLLECTION_BATCH_ADMIN_ONLY', 'COLLECTION_BATCH_NOT_PENDING', 'COLLECTION_BATCH_EMPTY'] as const

/**
 * PATCH /api/pending-operations/[id]/items: take invoices out of a pending
 * daily collections batch before approving it ("Bocka ur dem du inte vill
 * skicka"). Removal only, owner or administrator only (the people who may
 * approve the batch). The commit route takes no body, so this is how the
 * review dialog narrows the batch. The staged params stay frozen: the
 * removal is a row of its own (remove_collection_batch_items, which also
 * writes the audit row with the person), and the commit sends the staged
 * items less the removed ones.
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'pending_operation.narrow_items',
  async (request, ctx, { params }) => {
    const parsed = ParamsSchema.safeParse(await params)
    if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
    const body = await validateBody(request, NarrowBodySchema, { log: ctx.log, operation: 'pending_operation.narrow_items' })
    if (!body.success) return body.response

    // The batch must belong to the active company before anything is written.
    const { data: op, error } = await ctx.supabase
      .from('pending_operations')
      .select('id, operation_type')
      .eq('id', parsed.data.id)
      .eq('company_id', ctx.companyId)
      .maybeSingle()
    if (error) throw error
    if (!op || op.operation_type !== COLLECTIONS_BATCH_TYPE) {
      return errorResponseFromCode('COLLECTION_BATCH_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }

    const { error: rpcError } = await ctx.supabase.rpc('remove_collection_batch_items', {
      p_operation_id: parsed.data.id,
      p_invoice_ids: body.data.remove_invoice_ids,
    })
    if (rpcError) {
      const code = RPC_ERRORS.find((c) => rpcError.message?.includes(c))
      if (code) return errorResponseFromCode(code, ctx.log, { requestId: ctx.requestId })
      throw rpcError
    }
    return batchView(ctx, parsed.data.id)
  },
  { requireAdmin: true },
)
