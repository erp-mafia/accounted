import { z } from 'zod'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import {
  commitVacationYearClose,
  previewVacationYearClose,
} from '@/lib/salary/semesterberedning'
import { getVacationYearBasis } from '@/lib/salary/vacation-ledger'
import { getClosableYearStart } from '@/lib/salary/vacation-year'
import { getErrorEntry } from '@/lib/errors/structured-errors'

ensureInitialized()

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const CloseBody = z.object({
  vacation_year_start: isoDate.optional(),
  book_adjustment: z.boolean().default(true),
  /** true = return the review report only, write nothing. The dialog always
   * previews before the user confirms (soft-guard convention). */
  dry_run: z.boolean().default(false),
})

/** Semesterberedning + semesterårsavslut for the dashboard dialog
 * (payroll gap-closure 3.5). Same service as the v1 route and the MCP
 * executor. */
export const POST = withRouteContext(
  'salary.vacation-year-close',
  async (request, { supabase, companyId, user, log }) => {
    const validation = await validateBody(request, CloseBody)
    if (!validation.success) return validation.response
    const body = validation.data

    let yearStart = body.vacation_year_start
    if (!yearStart) {
      const basis = await getVacationYearBasis(supabase, companyId)
      yearStart = getClosableYearStart(new Date().toISOString().slice(0, 10), basis)
    }

    if (body.dry_run) {
      const preview = await previewVacationYearClose(supabase, companyId, yearStart)
      if (!preview.ok) {
        const entry = getErrorEntry(preview.code)
        return NextResponse.json(
          { error: entry?.message_sv ?? preview.code, code: preview.code },
          { status: entry?.httpStatus ?? 500 },
        )
      }
      return NextResponse.json({ data: { report: preview.data, committed: false } })
    }

    const result = await commitVacationYearClose(supabase, companyId, user.id, yearStart, {
      bookAdjustment: body.book_adjustment,
    })
    if (!result.ok) {
      const entry = getErrorEntry(result.code)
      log.warn('vacation year close failed', { code: result.code })
      return NextResponse.json(
        { error: entry?.message_sv ?? result.code, code: result.code, details: result.details },
        { status: entry?.httpStatus ?? 500 },
      )
    }

    return NextResponse.json({
      data: {
        committed: true,
        vacation_year_closure_id: result.data.closure_id,
        adjustment_entry_id: result.data.adjustment_entry_id,
        report: result.data.report,
      },
    })
  },
  { requireWrite: true },
)
