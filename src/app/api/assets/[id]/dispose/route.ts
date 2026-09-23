import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { disposeAsset } from '@/lib/bokslut/assets/asset-service'
import { DisposeAssetSchema } from '@/lib/bokslut/assets/asset-api'

export const POST = withRouteContext(
  'assets.dispose',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, DisposeAssetSchema)
    if (!validation.success) return validation.response
    try {
      const result = await disposeAsset(supabase, companyId, user.id, id, validation.data)
      return NextResponse.json({ data: result })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
