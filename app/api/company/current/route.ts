import { getActiveCompanyId } from '@/lib/company/context'
import { requireAuth } from '@/lib/auth/require-auth'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { AccountingFrameworkSchema } from '@/lib/api/schemas'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * GET /api/company/current
 *
 * Returns the active company id for the authenticated user. Used by the
 * client-side CompanyTabSync listener to detect cross-tab divergence (e.g.
 * when a tab was hidden/backgrounded during a switch in another tab) and
 * force a hard reload on mismatch.
 *
 * Never cached: the whole point is that the response reflects the current
 * authoritative value in user_preferences.
 *
 * Uses requireAuth() directly (not withRouteContext): a null companyId is a
 * valid answer here — the wrapper would short-circuit it into an error.
 */
export async function GET() {
  const auth = await requireAuth()
  if (auth.error) {
    auth.error.headers.set('Cache-Control', 'private, no-store')
    return auth.error
  }
  const { user, supabase } = auth

  const companyId = await getActiveCompanyId(supabase, user.id)

  return NextResponse.json(
    { companyId },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}

/**
 * Body shape for PATCH /api/company/current.
 *
 * Currently only carries `accounting_framework` (K2 / K3). Adding more
 * companies-level fields here is fine but anything that belongs on
 * company_settings should go to /api/settings instead.
 */
const PatchBodySchema = z.object({
  accounting_framework: AccountingFrameworkSchema.optional(),
})

/**
 * PATCH /api/company/current
 *
 * Updates company-level fields (in the `companies` table) for the active
 * company. Separate from /api/settings (which writes to `company_settings`)
 * because the columns live on different tables.
 *
 * Currently scoped to `accounting_framework` (K2 / K3), only meaningful for
 * entity_type='aktiebolag'. The handler rejects K3 for non-AB to prevent
 * impossible chart-of-accounts states downstream.
 */
export const PATCH = withRouteContext(
  'company.update_current',
  async (request, ctx) => {
  const { supabase, companyId } = ctx

  const validation = await validateBody(request, PatchBodySchema)
  if (!validation.success) return validation.response

  const updates: Record<string, unknown> = {}

  if (validation.data.accounting_framework !== undefined) {
    // Only AB can opt in to K3; EF stays on the simpler EF rules and never
    // touches K2/K3. Fetch the entity_type before applying.
    const { data: company } = await supabase
      .from('companies')
      .select('entity_type')
      .eq('id', companyId)
      .single()
    if (!company) {
      return NextResponse.json(
        { error: 'Företaget kunde inte hittas' },
        { status: 404 },
      )
    }
    if (
      validation.data.accounting_framework === 'k3'
      && company.entity_type !== 'aktiebolag'
    ) {
      return NextResponse.json(
        { error: 'K3 (BFNAR 2012:1) gäller endast aktiebolag.' },
        { status: 400 },
      )
    }
    updates.accounting_framework = validation.data.accounting_framework
  }

  if (Object.keys(updates).length === 0) {
    // Nothing to write: surface the current row so the client can refresh
    // its local state without a no-op write.
    const { data } = await supabase
      .from('companies')
      .select('id, accounting_framework, entity_type')
      .eq('id', companyId)
      .single()
    return NextResponse.json({ data })
  }

  const { data, error } = await supabase
    .from('companies')
    .update(updates)
    .eq('id', companyId)
    .select('id, accounting_framework, entity_type')
    .single()

  if (error) {
    return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
  }

  return NextResponse.json({ data })
  },
  { requireWrite: true },
)
