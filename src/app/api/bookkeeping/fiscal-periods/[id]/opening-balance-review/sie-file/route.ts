import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { previousYearHasBookkeeping, readSIEFileOpeningBalance } from '@/lib/import/opening-balance/sie-file'
import { setOpeningBalances } from '@/lib/import/opening-balance/service'
import { sessionFailureResponse } from '@/lib/operations/session'

type Params = { params: Promise<{ id: string }> }
const BookSchema = z.object({ reviewToken: z.uuid() }).strict()

/**
 * GET: the ingående balanser the year's own SIE file stated, which its
 * continuation import did not book (lib/import/opening-balance/sie-file.ts).
 * The review dialog previews them when the year has no IB verifikat.
 * `previous_year_booked` says the year before holds bokföring again (it was
 * imported anew after the undo that raised the review): the year's IB follows
 * it, so the dialog offers no booking and POST refuses one (PH 193).
 */
export const GET = withRouteContext<Params>('period.opening_balance.sie_file', async (_request, ctx, { params }) => {
  const { id } = await params
  if (!z.uuid().safeParse(id).success) {
    return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
  }
  const { data: period, error: periodError } = await ctx.supabase
    .from('fiscal_periods')
    .select('period_start')
    .eq('id', id)
    .eq('company_id', ctx.companyId!)
    .maybeSingle()
  if (periodError) throw periodError
  if (!period) return NextResponse.json({ data: null })

  const [file, previousYearBooked] = await Promise.all([
    readSIEFileOpeningBalance(ctx.supabase, ctx.companyId!, id),
    previousYearHasBookkeeping(ctx.supabase, ctx.companyId!, period.period_start),
  ])
  if (!file && !previousYearBooked) return NextResponse.json({ data: null })
  return NextResponse.json({
    data: {
      import_id: file?.importId ?? null,
      filename: file?.filename ?? null,
      lines: file?.lines ?? [],
      total_debit: file?.totalDebit ?? 0,
      total_credit: file?.totalCredit ?? 0,
      previous_year_booked: previousYearBooked,
    },
  })
})

/**
 * POST: books those balances as the year's IB verifikat through the same
 * service as the manual IB import, then signs off the review the dialog
 * showed. The review must still be open and the year still without IB.
 */
export const POST = withRouteContext<Params>(
  'period.opening_balance.sie_file_book',
  async (request, ctx, { params }) => {
    const { id } = await params
    if (!z.uuid().safeParse(id).success) {
      return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
    }
    const validation = await validateBody(request, BookSchema)
    if (!validation.success) return validation.response
    const { reviewToken } = validation.data

    const { data: period, error: periodError } = await ctx.supabase
      .from('fiscal_periods')
      .select('id, period_start, opening_balance_entry_id, opening_balance_review_token')
      .eq('id', id)
      .eq('company_id', ctx.companyId!)
      .maybeSingle()
    if (periodError) throw periodError
    if (!period) return errorResponseFromCode('OB_PERIOD_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    if (period.opening_balance_review_token !== reviewToken || period.opening_balance_entry_id) {
      return errorResponseFromCode('OB_REVIEW_CHANGED', ctx.log, { requestId: ctx.requestId })
    }
    // The review predates a new import of the year before: the year opens on
    // that year's utgående balanser again, and a second IB from the file
    // would break the continuity the import itself kept (prior_activity).
    if (await previousYearHasBookkeeping(ctx.supabase, ctx.companyId!, period.period_start)) {
      return errorResponseFromCode('OB_PREVIOUS_YEAR_BOOKED', ctx.log, { requestId: ctx.requestId })
    }

    const file = await readSIEFileOpeningBalance(ctx.supabase, ctx.companyId!, id)
    if (!file) return errorResponseFromCode('OB_SIE_FILE_MISSING', ctx.log, { requestId: ctx.requestId })

    const log = ctx.log.child({ fiscalPeriodId: id, sieImportId: file.importId })
    const outcome = await setOpeningBalances(
      { supabase: ctx.supabase, companyId: ctx.companyId!, userId: ctx.user.id, log },
      { fiscal_period_id: id, lines: file.lines, description: `Ingående balanser från SIE-filen ${file.filename}`.trim() },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, ctx.requestId)
    if (outcome.dryRun) throw new Error('unreachable: no dry run on the dashboard')

    // The IB is the record; the sign-off only clears the review. A refused
    // sign-off leaves the review open for the owner to confirm by hand.
    const { error: reviewError } = await ctx.supabase.rpc('acknowledge_sie_opening_balance_review', {
      p_company_id: ctx.companyId,
      p_period_id: id,
      p_actor: ctx.user.id,
      p_review_token: reviewToken,
      p_expected_entry_id: outcome.data.journal_entry_id,
    })
    if (reviewError) log.warn('opening balance booked, review sign-off refused', { code: reviewError.code })

    return NextResponse.json({
      data: {
        journal_entry_id: outcome.data.journal_entry_id,
        voucher_series: outcome.data.voucher_series,
        voucher_number: outcome.data.voucher_number,
        reviewed: !reviewError,
      },
    })
  },
  { requireAdmin: true },
)
