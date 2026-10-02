import { NextResponse } from 'next/server'
import { privateNoStore } from '@/lib/api/private-no-store'
import { validateBody } from '@/lib/api/validate'
import { withRouteContext } from '@/lib/api/with-route-context'
import { ensureInitialized } from '@/lib/init'
import { PeppolAccessRequestSchema, requestPeppolAccessForCompany } from '@/lib/invoices/peppol-settings-service'
import { sessionFailureResponse } from '@/lib/operations/session'
import { createServiceClient } from '@/lib/supabase/server'

ensureInitialized()

/**
 * POST /api/settings/peppol/access: the company asks for Peppol access.
 *
 * Writes the request row (service role; the browser cannot grant itself
 * anything) and tells the operators by e-mail. The rules live in
 * lib/invoices/peppol-settings-service.ts, shared with the v1 operation
 * peppol.request-access.
 */
export const POST = withRouteContext(
  'settings.peppol.access.request',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, PeppolAccessRequestSchema)
    if (!validation.success) return validation.response

    const outcome = await requestPeppolAccessForCompany(
      { supabase, companyId, userId: user.id, log },
      validation.data,
      { service: createServiceClient(), requesterEmail: user.email ?? null },
    )
    if (!outcome.ok) return privateNoStore(sessionFailureResponse(outcome, log, requestId))
    if (outcome.dryRun) return privateNoStore(NextResponse.json({ data: outcome.preview }))
    return privateNoStore(NextResponse.json(
      { data: { access: outcome.data.access } },
      { status: outcome.data.created ? 201 : 200 },
    ))
  },
  { requireWrite: true },
)
