import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { buildCanonicalAnnualReport } from '@/lib/bokslut/arsredovisning/model'
import { getAnnualReportCapabilities } from '@/lib/bokslut/arsredovisning/capabilities'
import { upsertAnnualReportProfile } from '@/lib/bokslut/arsredovisning/profile-service'

const NullableBoolean = z.boolean().nullable()

const PatchSchema = z
  .object({
    is_public_limited_company: NullableBoolean.optional(),
    is_in_liquidation: NullableBoolean.optional(),
    securities_traded_on_regulated_market: NullableBoolean.optional(),
    is_parent_company: NullableBoolean.optional(),
    parent_group_size: z.enum(['none', 'small', 'large']).nullable().optional(),
    prepares_consolidated_accounts: NullableBoolean.optional(),
    has_foreign_branch: NullableBoolean.optional(),
    has_crypto_assets: NullableBoolean.optional(),
    has_share_based_payments: NullableBoolean.optional(),
    has_convertible_debt: NullableBoolean.optional(),
    building_revenue_share_pct: z.number().min(0).max(100).nullable().optional(),
    has_material_deferred_tax: NullableBoolean.optional(),
    reporting_currency: z.enum(['SEK', 'EUR']).optional(),
    auditor_report_required: NullableBoolean.optional(),
    auditor_report_included: z.boolean().optional(),
    dividend_prudence_confirmed: NullableBoolean.optional(),
    narrative_confirmed: z.boolean().optional(),
    k2_assessment_confirmed: z.boolean().optional(),
    signer_roster_confirmed: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' })

async function periodExists(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .maybeSingle()
  return Boolean(data)
}

function responseData(model: Awaited<ReturnType<typeof buildCanonicalAnnualReport>>) {
  return {
    profile: model.profile,
    disclosures: model.disclosures,
    eligibility: model.eligibility,
    validation: model.validation,
    capabilities: getAnnualReportCapabilities(
      model.entity_type,
      model.report.accounting_framework,
      model.eligibility,
    ),
    report_summary: {
      proposed_dividend: model.report.forvaltningsberattelse.proposed_dividend,
      distributable_equity:
        model.report.forvaltningsberattelse.resultatdisposition_amounts.total,
    },
  }
}

export const GET = withRouteContext(
  'period.arsredovisning_compliance_get',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    try {
      const model = await buildCanonicalAnnualReport(supabase, companyId, id, {
        stage: 'draft',
        includeIxbrl: false,
      })
      return NextResponse.json({ data: responseData(model) })
    } catch (err) {
      // No periodExists preflight here: buildArsredovisningData applies the
      // same company_id filter and throws 'Fiscal period not found' for
      // missing/foreign periods, so mapping that message (mirroring the data
      // route) yields the identical 404 envelope without the extra round
      // trip. PATCH keeps the preflight since it guards the profile upsert
      // before any write.
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      return errorResponse(err, log, { requestId })
    }
  },
)

export const PATCH = withRouteContext(
  'period.arsredovisning_compliance_patch',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, PatchSchema)
    if (!validation.success) return validation.response
    try {
      if (!(await periodExists(supabase, companyId, id))) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      const {
        narrative_confirmed,
        k2_assessment_confirmed,
        signer_roster_confirmed,
        ...profileFields
      } = validation.data
      const now = new Date().toISOString()
      await upsertAnnualReportProfile(supabase, companyId, user.id, id, {
        ...profileFields,
        ...(narrative_confirmed !== undefined
          ? { narrative_confirmed_at: narrative_confirmed ? now : null }
          : {}),
        ...(k2_assessment_confirmed !== undefined
          ? { k2_assessment_confirmed_at: k2_assessment_confirmed ? now : null }
          : {}),
        ...(signer_roster_confirmed !== undefined
          ? { signer_roster_confirmed_at: signer_roster_confirmed ? now : null }
          : {}),
      })
      const model = await buildCanonicalAnnualReport(supabase, companyId, id, {
        stage: 'draft',
        includeIxbrl: false,
      })
      return NextResponse.json({ data: responseData(model) })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
