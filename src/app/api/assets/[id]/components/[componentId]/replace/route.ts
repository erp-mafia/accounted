import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { ReplaceComponentSchema, replacementPreviewView } from '@/lib/bokslut/assets/asset-api'
import {
  previewComponentReplacement,
  replaceAssetComponent,
} from '@/lib/bokslut/assets/component-service'

type Params = { params: Promise<{ id: string; componentId: string }> }

const BodySchema = ReplaceComponentSchema.extend({
  /** True: answer the voucher the replacement would post, post nothing. */
  dry_run: z.boolean().optional(),
})

/**
 * Replace a component (K3 17.5, 17.21A): one voucher takes the replaced
 * component's carrying amount off the books (its depreciation to date, its
 * accumulated depreciation and cost, the rest as a loss) and the replacing
 * component is registered. dry_run answers the plan the confirm dialog shows.
 */
export const POST = withRouteContext<Params>(
  'assets.components.replace',
  async (request, ctx, { params }) => {
    const { id, componentId } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, BodySchema)
    if (!validation.success) return validation.response
    const { dry_run: dryRun, ...input } = validation.data
    try {
      if (dryRun) {
        const preview = await previewComponentReplacement(supabase, companyId, id, componentId, input)
        return NextResponse.json({ data: replacementPreviewView(preview) })
      }
      const result = await replaceAssetComponent(supabase, companyId, user.id, id, componentId, input)
      return NextResponse.json({
        data: {
          asset: result.asset,
          journal_entry_id: result.entry.id,
          new_component_id: result.newComponentId,
        },
      })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
