import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { updateFiscalPeriod } from '@/lib/core/bookkeeping/fiscal-year-service'
import { sessionFailureResponse } from '@/lib/operations/session'
import { z } from 'zod'

const UpdateFiscalPeriodSchema = z.object({
  name: z.string().min(1).optional(),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Startdatum måste vara i format ÅÅÅÅ-MM-DD').optional(),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Slutdatum måste vara i format ÅÅÅÅ-MM-DD').optional(),
})

/**
 * PATCH /api/bookkeeping/fiscal-periods/[id]: rename or re-date an open
 * räkenskapsår. The rules (closed/locked years never change, dates never move
 * under posted verifikat, BFL 3 kap. shape, enskild firma calendar year,
 * overlap 409) live in lib/core/bookkeeping/fiscal-year-service.ts, shared
 * with the v1 operation fiscal-periods.update and gnubok_update_fiscal_period.
 * Failures answer the canonical `{ error: { code, message } }` envelope; the
 * fiscal-year settings UI reads error.message.
 */
export const PATCH = withRouteContext(
  'period.update',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx
    const opLog = log.child({ periodId: id })

    const validation = await validateBody(request, UpdateFiscalPeriodSchema)
    if (!validation.success) return validation.response

    const outcome = await updateFiscalPeriod({ supabase, companyId, userId: user.id, log: opLog }, id, validation.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, opLog, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
