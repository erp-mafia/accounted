import { getActiveCompanyId } from '@/lib/company/context'
import { requireAuth } from '@/lib/auth/require-auth'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { AccountingFrameworkSchema, EntityTypeSchema } from '@/lib/api/schemas'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

import { isEntityType, supportsAccountingFramework } from '@/lib/company/entity-type'
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
  /**
   * Legal-form correction for a company whose books are still empty (no
   * verifikat, invoices or supplier invoices, only seeded accounts). Runs
   * through correct_company_entity_type(), which is owner-only and re-seeds
   * the chart for the new form; a company with any bookkeeping is refused.
   */
  entity_type: EntityTypeSchema.optional(),
})

const ENTITY_TYPE_CHANGE_ERRORS: Record<string, { status: number; message: string }> = {
  ENTITY_TYPE_CHANGE_FORBIDDEN: { status: 403, message: 'Endast företagets ägare kan ändra företagsform.' },
  ENTITY_TYPE_CHANGE_NOT_FOUND: { status: 404, message: 'Företaget kunde inte hittas' },
  ENTITY_TYPE_CHANGE_UNSUPPORTED: { status: 400, message: 'Företagsformen stöds inte.' },
  ENTITY_TYPE_CHANGE_BOOKS_NOT_EMPTY: {
    status: 409,
    message: 'Företagsformen kan bara ändras innan bokföringen har börjat: det finns redan verifikat eller fakturor. Kontakta support för en granskad ändring.',
  },
  ENTITY_TYPE_CHANGE_CONFIGURED_ACCOUNTS: {
    status: 409,
    message: 'Företagsformen kan bara ändras innan konteringsregler eller dimensionsregler har skapats: ta bort dem först.',
  },
  ENTITY_TYPE_CHANGE_CUSTOM_ACCOUNTS: {
    status: 409,
    message: 'Företagsformen kan bara ändras när kontoplanen bara innehåller de förvalda kontona: ta bort egna konton först.',
  },
}

/**
 * PATCH /api/company/current
 *
 * Updates company-level fields (in the `companies` table) for the active
 * company. Separate from /api/settings (which writes to `company_settings`)
 * because the columns live on different tables.
 *
 * Currently scoped to `accounting_framework` (K2 / K3), only meaningful for
 * forms that prepare an årsredovisning (aktiebolag, ekonomisk förening). The
 * handler rejects K3 for every other form to prevent impossible
 * chart-of-accounts states downstream.
 */
export const PATCH = withRouteContext(
  'company.update_current',
  async (request, ctx) => {
  const { supabase, companyId } = ctx

  const validation = await validateBody(request, PatchBodySchema)
  if (!validation.success) return validation.response

  const updates: Record<string, unknown> = {}

  if (validation.data.accounting_framework !== undefined) {
    // Only forms that prepare an årsredovisning can opt in to K3 (BFNAR
    // 2012:1); an enskild firma stays on its own rules and never touches
    // K2/K3. Fetch the entity_type before applying.
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
      && !(isEntityType(company.entity_type) && supportsAccountingFramework(company.entity_type, 'k3'))
    ) {
      return NextResponse.json(
        { error: 'K3 (BFNAR 2012:1) gäller endast företag som upprättar årsredovisning (aktiebolag och ekonomisk förening).' },
        { status: 400 },
      )
    }
    updates.accounting_framework = validation.data.accounting_framework
  }

  if (validation.data.entity_type !== undefined) {
    const { data, error } = await supabase.rpc('correct_company_entity_type', {
      p_company_id: companyId,
      p_entity_type: validation.data.entity_type,
    })
    if (error) {
      return NextResponse.json({ error: 'Företagsformen kunde inte ändras' }, { status: 500 })
    }
    const result = (data ?? {}) as { ok?: boolean; code?: string; changed?: boolean }
    if (!result.ok) {
      const mapped = ENTITY_TYPE_CHANGE_ERRORS[result.code ?? ''] ?? {
        status: 400,
        message: 'Företagsformen kunde inte ändras',
      }
      return NextResponse.json({ error: mapped.message, code: result.code }, { status: mapped.status })
    }
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
