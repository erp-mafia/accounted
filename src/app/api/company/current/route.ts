import { getActiveCompanyId } from '@/lib/company/context'
import { requireAuth } from '@/lib/auth/require-auth'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { AccountingFrameworkSchema, EntityTypeSchema } from '@/lib/api/schemas'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  isEntityType,
  isEntityTypeCreatable,
  supportsAccountingFramework,
} from '@/lib/company/entity-type'
import { changeAccountingFramework } from '@/lib/company/accounting-framework-change'

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
 * Carries the K2 / K3 framework of a räkenskapsår (with what BFNAR 2012:4
 * asks of a switch from K3 to K2) and the legal-form correction. Adding more
 * companies-level fields here is fine but anything that belongs on
 * company_settings should go to /api/settings instead.
 */
const PatchBodySchema = z.object({
  accounting_framework: AccountingFrameworkSchema.optional(),
  /**
   * The räkenskapsår the framework applies to. Omitted: the year running
   * today. The framework is stored per year (lib/company/accounting-framework.ts);
   * later years that only followed this one move with it.
   */
  fiscal_period_id: z.string().uuid().optional(),
  /** BFNAR 2012:4 punkt 3: why the company leaves K3 for K2; printed in a note. */
  framework_change_reason: z
    .string()
    .max(2000)
    .transform((value) => value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''))
    .nullable()
    .optional(),
  /** Whether the company applied a K2 regelverk before (BFNAR 2012:4 punkt 2). */
  previously_applied_k2: z.boolean().nullable().optional(),
  /** The stated reasons are särskilda skäl, not tax reasons. */
  special_reasons_confirmed: z.boolean().nullable().optional(),
  /**
   * The framework the previous årsredovisning was prepared under (none: no
   * previous årsredovisning), when Accounted holds no reliable record of it.
   */
  previous_year_framework: z.enum(['k2', 'k3', 'none']).nullable().optional(),
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
 * Scoped to `accounting_framework` (K2 / K3) and, while the books are empty,
 * `entity_type` (see correct_company_entity_type). K3 is only meaningful for
 * forms that prepare an årsredovisning under it (aktiebolag today); the
 * handler validates the RESULTING (entity_type, accounting_framework) pair,
 * so a legal-form change can neither keep K3 on a form that never uses it
 * nor be judged against the form the company is leaving.
 *
 * A framework change applies to one räkenskapsår (fiscal_period_id, default
 * the year running today) under BFNAR 2012:4 (changeAccountingFramework):
 * refused on a closed or locked year or one whose årsredovisning is locked or
 * signed, and a switch from K3 to K2 carries its reasons.
 */
export const PATCH = withRouteContext(
  'company.update_current',
  async (request, ctx) => {
  const { supabase, companyId } = ctx

  const validation = await validateBody(request, PatchBodySchema)
  if (!validation.success) return validation.response

  const wantsFramework = validation.data.accounting_framework !== undefined
  const wantsEntityType = validation.data.entity_type !== undefined

  if (wantsFramework || wantsEntityType) {
    const { data: company } = await supabase
      .from('companies')
      .select('entity_type, accounting_framework')
      .eq('id', companyId)
      .single()
    if (!company) {
      return NextResponse.json(
        { error: 'Företaget kunde inte hittas' },
        { status: 404 },
      )
    }
    // Only forms that prepare an årsredovisning under K3 (BFNAR 2012:1) can
    // carry it; an enskild firma and an ideell förening close with an
    // årsbokslut and an ekonomisk förening is K2-only until its K3 document
    // ships. Judge the pair the row will hold after this request, not the
    // form it holds now.
    const resultingEntityType = validation.data.entity_type ?? company.entity_type
    const resultingFramework = validation.data.accounting_framework ?? company.accounting_framework
    if (
      resultingFramework === 'k3'
      && !(isEntityType(resultingEntityType) && supportsAccountingFramework(resultingEntityType, 'K3'))
    ) {
      return NextResponse.json(
        {
          error: wantsEntityType && !wantsFramework
            ? 'Företagsformen kan inte ändras medan K3 är valt: välj K2 först, eller skicka accounting_framework tillsammans med företagsformen.'
            : 'K3 (BFNAR 2012:1) kan bara väljas av ett aktiebolag; en ekonomisk förening upprättar årsredovisningen enligt K2 och övriga företagsformer upprättar årsbokslut.',
        },
        { status: 400 },
      )
    }
  }

  const frameworkInput = () => ({
    framework: validation.data.accounting_framework!,
    fiscal_period_id: validation.data.fiscal_period_id,
    change_reason: validation.data.framework_change_reason ?? null,
    previously_applied_k2: validation.data.previously_applied_k2 ?? null,
    special_reasons_confirmed: validation.data.special_reasons_confirmed ?? null,
    previous_year_framework: validation.data.previous_year_framework ?? null,
  })

  // Framework only: one räkenskapsår under BFNAR 2012:4.
  if (wantsFramework && !wantsEntityType) {
    const fiscalYear = await changeAccountingFramework(
      { supabase, companyId, userId: ctx.user.id },
      frameworkInput(),
    )
    const { data } = await supabase
      .from('companies')
      .select('id, accounting_framework, entity_type')
      .eq('id', companyId)
      .single()
    return NextResponse.json({ data: { ...(data ?? {}), fiscal_year: fiscalYear } })
  }

  if (validation.data.entity_type !== undefined) {
    // A correction may only land on a form a new company could be created
    // as: a beta form stays closed until its creation flag is on.
    if (!isEntityTypeCreatable(validation.data.entity_type)) {
      return NextResponse.json(
        { error: ENTITY_TYPE_CHANGE_ERRORS.ENTITY_TYPE_CHANGE_UNSUPPORTED.message, code: 'ENTITY_TYPE_CHANGE_UNSUPPORTED' },
        { status: 400 },
      )
    }
    const { data, error } = await supabase.rpc('correct_company_entity_type', {
      p_company_id: companyId,
      p_entity_type: validation.data.entity_type,
      p_accounting_framework: validation.data.accounting_framework ?? null,
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
    // A changed form moves the open years with it (the database trigger on
    // companies.entity_type). With the form unchanged the RPC only wrote the
    // company default, so the framework is applied to the year as above.
    if (wantsFramework && result.changed === false) {
      await changeAccountingFramework({ supabase, companyId, userId: ctx.user.id }, frameworkInput())
    }
  }

  // Surface the row as it stands so the client can refresh its local state.
  const { data } = await supabase
    .from('companies')
    .select('id, accounting_framework, entity_type')
    .eq('id', companyId)
    .single()
  return NextResponse.json({ data })
  },
  // companies is writable by owner/admin only (RLS, user_is_company_admin).
  // With requireWrite a `member` reached the UPDATE, matched zero rows, and
  // `.single()` turned that into a 500.
  { requireAdmin: true },
)
