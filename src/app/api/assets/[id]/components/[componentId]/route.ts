import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { UpdateComponentSchema } from '@/lib/bokslut/assets/asset-api'
import { deleteAssetComponent, updateAssetComponent } from '@/lib/bokslut/assets/component-service'

type Params = { params: Promise<{ id: string; componentId: string }> }

/**
 * Change one component. Name, useful life and salvage value always (a changed
 * estimate applies from now on); cost, dates and opening only until the
 * component's depreciation has posted (409 ASSET_CORRECTION_BLOCKED).
 */
export const PATCH = withRouteContext<Params>(
  'assets.components.update',
  async (request, ctx, { params }) => {
    const { id, componentId } = await params
    const { supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, UpdateComponentSchema)
    if (!validation.success) return validation.response
    try {
      const asset = await updateAssetComponent(supabase, companyId, id, componentId, validation.data)
      return NextResponse.json({ data: asset })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true, uuidParams: { id: 'ASSET_NOT_FOUND', componentId: 'ASSET_COMPONENT_NOT_FOUND' } },
)

/** Remove a component that never reached the books. */
export const DELETE = withRouteContext<Params>(
  'assets.components.delete',
  async (_request, ctx, { params }) => {
    const { id, componentId } = await params
    const { supabase, companyId, log, requestId } = ctx
    try {
      const asset = await deleteAssetComponent(supabase, companyId, id, componentId)
      return NextResponse.json({ data: asset })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true, uuidParams: { id: 'ASSET_NOT_FOUND', componentId: 'ASSET_COMPONENT_NOT_FOUND' } },
)
