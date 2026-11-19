import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { AddComponentSchema } from '@/lib/bokslut/assets/asset-api'
import { addAssetComponent } from '@/lib/bokslut/assets/component-service'

/**
 * Register a tillkommande component on a K3 component asset (BFNAR 2012:1
 * 17.5). No voucher: the expenditure is already on the asset account.
 */
export const POST = withRouteContext(
  'assets.components.add',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, AddComponentSchema)
    if (!validation.success) return validation.response
    try {
      const asset = await addAssetComponent(supabase, companyId, user.id, id, validation.data)
      return NextResponse.json({ data: asset })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
