import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { MarkVatCheckReviewedSchema, VatCheckReviewTargetSchema, VatFilingPeriodSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { resolvePeriodDates } from '@/lib/reports/vat-declaration'
import { createServiceClient } from '@/lib/supabase/server'
import { listVatCheckReviews } from '@/lib/vat/check-review-store'
import { markVatCheckReviewed, withdrawVatCheckReview } from '@/lib/vat/check-review-service'
import { z } from 'zod'

/**
 * /api/reports/vat-declaration/check-reviews (crm#1171)
 *
 * The momsdeklaration view's reviewed warnings: a person accepts one WARNING
 * of "Kontroll av underlaget" for the period, and the view applies the review
 * while the finding's figures are unchanged (lib/vat/check-reviews.ts). An
 * ERROR is never reviewable; the service refuses it.
 *
 *   GET    ?period_type&year&period[&fiscal_period_id] -> { data: VatCheckReview[] }
 *   POST   { period_type, year, period, fiscal_period_id?, check_code, note?, expected_fingerprint? }
 *          -> { data: MarkedVatCheckReview }
 *   DELETE ?period_type&year&period[&fiscal_period_id]&check_code -> { data: { withdrawn: true } }
 *
 * Agents reach the same service through the staged MCP tool
 * gnubok_mark_vat_check_reviewed (lib/operations/vat-check-reviews.ts).
 */
const ListQuerySchema = VatFilingPeriodSchema.and(z.object({ fiscal_period_id: z.string().uuid().optional() }))

export const GET = withRouteContext('report.vat_check_reviews.list', async (request, ctx) => {
  const { supabase, companyId } = ctx
  const validation = validateQuery(request, ListQuerySchema)
  if (!validation.success) return validation.response
  const query = validation.data
  const { start, end } = await resolvePeriodDates(
    supabase, companyId!, query.period_type, query.year, query.period, query.fiscal_period_id,
  )
  // Colleagues' names: a session reads only its own profile, so the names of
  // the people behind this company's reviews come through the service role.
  const data = await listVatCheckReviews(supabase, companyId!, { start, end }, { labelClient: createServiceClient() })
  return NextResponse.json({ data })
})

export const POST = withRouteContext(
  'report.vat_check_reviews.mark',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = await validateBody(request, MarkVatCheckReviewedSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    const result = await markVatCheckReviewed(supabase, companyId!, user.id, {
      periodType: body.period_type,
      year: body.year,
      period: body.period,
      fiscalPeriodId: body.fiscal_period_id,
      checkCode: body.check_code,
      note: body.note ?? null,
      expectedFingerprint: body.expected_fingerprint,
      source: 'web',
    })
    if (!result.ok) return errorResponseFromCode(result.code, log, { requestId })
    if (result.dryRun) return NextResponse.json({ data: result.preview })
    return NextResponse.json({ data: result.data })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext(
  'report.vat_check_reviews.withdraw',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = validateQuery(request, VatCheckReviewTargetSchema)
    if (!validation.success) return validation.response
    const query = validation.data

    const result = await withdrawVatCheckReview(supabase, companyId!, user.id, {
      periodType: query.period_type,
      year: query.year,
      period: query.period,
      fiscalPeriodId: query.fiscal_period_id,
      checkCode: query.check_code,
      source: 'web',
    })
    if (!result.ok) return errorResponseFromCode(result.code, log, { requestId })
    return NextResponse.json({ data: result.data })
  },
  { requireWrite: true },
)
