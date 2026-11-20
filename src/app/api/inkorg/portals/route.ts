import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateCompanyPortalSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createCompanyPortal, listCompanyPortals } from '@/lib/inkorg/portal-service'

/**
 * GET /api/inkorg/portals
 *
 * The supplier portals the company added itself (public.company_portals):
 * id, counterparty_key, vendor_name, url, created_at, updated_at, by name.
 * The directory's portals are not listed: they are shared, not the
 * company's, and every purchase already carries the one that answers for it
 * (GET /api/extensions/ext/invoice-inbox/purchases).
 */
export const GET = withRouteContext('inkorg.portals.list', async (_request, { supabase, companyId }) => {
  return NextResponse.json({ data: await listCompanyPortals(supabase, companyId) })
})

/**
 * POST /api/inkorg/portals
 *
 * "The invoice is in a portal": body { transaction_id, url }. The supplier is
 * the purchase's own counterparty, read off the company's bank row on the
 * server (lib/inkorg/portal-service.ts), so the client never names it. Every
 * purchase from that supplier, earlier and later, then leads with the portal.
 * A supplier that has a portal already gets the new link.
 *
 * 200 { data: portal }. 400 INKORG_PORTAL_URL_INVALID (not https, userinfo,
 * no dotted host, too long), 404 INKORG_PORTAL_PURCHASE_NOT_FOUND, 422
 * INKORG_PORTAL_NO_SUPPLIER (salary, tax, a row that names nobody).
 */
export const POST = withRouteContext(
  'inkorg.portals.create',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, CreateCompanyPortalSchema, { log, operation: 'inkorg.portals.create' })
    if (!validation.success) return validation.response

    const outcome = await createCompanyPortal(supabase, companyId, user.id, {
      transactionId: validation.data.transaction_id,
      url: validation.data.url,
    })
    if (!outcome.ok) return errorResponseFromCode(outcome.code, log, { requestId })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
