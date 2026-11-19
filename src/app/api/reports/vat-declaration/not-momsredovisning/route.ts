import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { VatFilingPeriodSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { resolvePeriodDates } from '@/lib/reports/vat-declaration'
import { createServiceClient } from '@/lib/supabase/server'
import {
  listMarkedInPeriod,
  markNotMomsredovisning,
  withdrawNotMomsredovisning,
} from '@/lib/vat/momsredovisning-marks'

/**
 * /api/reports/vat-declaration/not-momsredovisning (crm#1849)
 *
 * The Moms page's "rättelse, inte momsredovisning": a person tells the
 * momsdeklaration that a posted verifikat the momsredovisning shapes catch is
 * not a momsredovisning, so the rutor read it and it stops counting as the
 * period's momsredovisning (lib/vat/momsredovisning-marks.ts).
 *
 *   GET    ?period_type&year&period[&fiscal_period_id]
 *          -> { data: MarkedMomsredovisningEntry[] } (the period's marked verifikat)
 *   POST   { journal_entry_id }     -> { data: MomsredovisningMarkResult }
 *   DELETE ?journal_entry_id=<uuid> -> { data: MomsredovisningMarkResult }
 */
const TargetSchema = z.object({ journal_entry_id: z.string().uuid() })
const ListQuerySchema = VatFilingPeriodSchema.and(z.object({ fiscal_period_id: z.string().uuid().optional() }))

export const GET = withRouteContext('report.vat_momsredovisning_mark.list', async (request, ctx) => {
  const { supabase, companyId } = ctx
  const validation = validateQuery(request, ListQuerySchema)
  if (!validation.success) return validation.response
  const query = validation.data
  const { start, end } = await resolvePeriodDates(
    supabase, companyId!, query.period_type, query.year, query.period, query.fiscal_period_id,
  )
  const data = await listMarkedInPeriod(supabase, companyId!, { start, end })
  return NextResponse.json({ data })
})

export const POST = withRouteContext(
  'report.vat_momsredovisning_mark.mark',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = await validateBody(request, TargetSchema)
    if (!validation.success) return validation.response

    // The session reads and checks; only the server records the mark.
    const result = await markNotMomsredovisning(
      supabase, createServiceClient(), companyId!, user.id, validation.data.journal_entry_id,
    )
    if (!result.ok) return errorResponseFromCode(result.code, log, { requestId })
    return NextResponse.json({ data: result.data })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext(
  'report.vat_momsredovisning_mark.withdraw',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = validateQuery(request, TargetSchema)
    if (!validation.success) return validation.response

    const result = await withdrawNotMomsredovisning(
      supabase, createServiceClient(), companyId!, user.id, validation.data.journal_entry_id,
    )
    if (!result.ok) return errorResponseFromCode(result.code, log, { requestId })
    return NextResponse.json({ data: result.data })
  },
  { requireWrite: true },
)
