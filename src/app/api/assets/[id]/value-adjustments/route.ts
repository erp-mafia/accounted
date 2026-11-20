import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { ValueAdjustmentSchema, valueAdjustmentPreviewView } from '@/lib/bokslut/assets/asset-api'
import {
  postValueAdjustment,
  previewValueAdjustment,
} from '@/lib/bokslut/assets/value-adjustment-service'

type Params = { params: Promise<{ id: string }> }

const BodySchema = ValueAdjustmentSchema.extend({
  /** True: answer the voucher the write-down would post, post nothing. */
  dry_run: z.boolean().optional(),
})

/**
 * Write an asset down to its recoverable amount, or reverse an earlier
 * write-down (ÅRL 4 kap. 5 §, K3 27), on a balansdag: one voucher (77xx
 * against 12x8) and the register rows in one transaction. dry_run answers
 * the plan the confirm dialog shows.
 */
export const POST = withRouteContext<Params>(
  'assets.value_adjustments.create',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, BodySchema)
    if (!validation.success) return validation.response
    const { dry_run: dryRun, ...input } = validation.data
    try {
      if (dryRun) {
        const preview = await previewValueAdjustment(supabase, companyId, id, input)
        return NextResponse.json({ data: valueAdjustmentPreviewView(preview) })
      }
      const result = await postValueAdjustment(supabase, companyId, user.id, id, input)
      return NextResponse.json({
        data: {
          asset: result.asset,
          journal_entry_id: result.entry.id,
          amount: result.preview.amount,
        },
      })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
