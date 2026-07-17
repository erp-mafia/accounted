import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  alignDraftDatesFromSourceDates,
  batchUpdateDraftEntryDates,
  suggestVatPeriod,
} from '@/lib/workspace/date-tools'

const bodySchema = z.object({
  action: z.enum(['set_dates', 'align_from_source', 'suggest_vat_period']),
  updates: z
    .array(
      z.object({
        entry_id: z.string().uuid(),
        entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
    )
    .optional(),
  items: z
    .array(
      z.object({
        entry_id: z.string().uuid(),
        source_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
    )
    .optional(),
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  vat_period_months: z.union([z.literal(1), z.literal(3)]).optional(),
})

export const POST = withRouteContext(
  'workspace.date-tools',
  async (request, ctx) => {
    const { supabase, companyId } = ctx
    try {
      const json = await request.json()
      const parsed = bodySchema.safeParse(json)
      if (!parsed.success) {
        return errorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: { issues: parsed.error.issues },
        })
      }

      const body = parsed.data

      if (body.action === 'suggest_vat_period') {
        if (!body.entry_date) {
          return errorResponseFromCode('VALIDATION_ERROR', ctx.log, {
            requestId: ctx.requestId,
            details: { issues: [{ field: 'entry_date', message: 'Required' }] },
          })
        }
        return NextResponse.json({
          data: {
            vat_period: suggestVatPeriod(body.entry_date, body.vat_period_months ?? 1),
          },
        })
      }

      if (body.action === 'align_from_source') {
        if (!body.items?.length) {
          return errorResponseFromCode('VALIDATION_ERROR', ctx.log, {
            requestId: ctx.requestId,
            details: { issues: [{ field: 'items', message: 'Required' }] },
          })
        }
        const result = await alignDraftDatesFromSourceDates(
          supabase,
          companyId,
          body.items.map((i) => ({ entryId: i.entry_id, sourceDate: i.source_date })),
        )
        return NextResponse.json({ data: result })
      }

      // set_dates
      if (!body.updates?.length) {
        return errorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: { issues: [{ field: 'updates', message: 'Required' }] },
        })
      }
      const result = await batchUpdateDraftEntryDates(
        supabase,
        companyId,
        body.updates.map((u) => ({ entryId: u.entry_id, entryDate: u.entry_date })),
      )
      return NextResponse.json({ data: result })
    } catch (err) {
      return errorResponse(err, ctx.log, { requestId: ctx.requestId })
    }
  },
  { requireWrite: true },
)
