import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateCompanyPortalSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { isUuid } from '@/lib/invariants/uuid'
import { deleteCompanyPortal, updateCompanyPortal } from '@/lib/inkorg/portal-service'

type Params = { params: Promise<{ id: string }> }

/**
 * PATCH /api/inkorg/portals/:id
 *
 * A new link for one of the company's own portals: body { url }, under the
 * same URL rule as adding one. Which supplier it is stays as it was. 400
 * INKORG_PORTAL_URL_INVALID, 404 INKORG_PORTAL_NOT_FOUND when the portal is
 * not the company's.
 */
export const PATCH = withRouteContext<Params>(
  'inkorg.portals.update',
  async (request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, UpdateCompanyPortalSchema, { log, operation: 'inkorg.portals.update' })
    if (!validation.success) return validation.response
    if (!isUuid(id)) return errorResponseFromCode('INKORG_PORTAL_NOT_FOUND', log, { requestId })

    const outcome = await updateCompanyPortal(supabase, companyId, id, validation.data.url)
    if (!outcome.ok) return errorResponseFromCode(outcome.code, log, { requestId })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)

/**
 * DELETE /api/inkorg/portals/:id
 *
 * Takes one of the company's own portals away: its supplier's purchases go
 * back to the directory's portal, or to none. 404 INKORG_PORTAL_NOT_FOUND
 * when the portal is not the company's.
 */
export const DELETE = withRouteContext<Params>(
  'inkorg.portals.delete',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    if (!isUuid(id)) return errorResponseFromCode('INKORG_PORTAL_NOT_FOUND', log, { requestId })

    const outcome = await deleteCompanyPortal(supabase, companyId, id)
    if (!outcome.ok) return errorResponseFromCode(outcome.code, log, { requestId })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
