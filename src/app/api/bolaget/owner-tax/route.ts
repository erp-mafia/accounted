import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { bolagetGateResponse, callerIsCompanyAdmin, operationContext } from '@/lib/bolaget/session'
import { loadK10Year } from '@/lib/bolaget/owner-tax/k10'
import { loadKu20Status } from '@/lib/bolaget/owner-tax/ku20'
import { loadBoardLoansNote, loadOwnerLoansView, specialList } from '@/lib/bolaget/owner-tax/loans-view'
import { readIncomeYear } from './year'

/** The balance day of the räkenskapsår that ends in the year, else 31 December. */
async function balanceDateOf(ctx: Parameters<typeof operationContext>[0], year: number): Promise<string> {
  const { data, error } = await ctx.supabase
    .from('fiscal_periods')
    .select('period_end')
    .eq('company_id', ctx.companyId)
    .gte('period_end', `${year}-01-01`)
    .lte('period_end', `${year}-12-31`)
    .order('period_end', { ascending: false })
    .limit(1)
  if (error) throw new Error(`fiscal_periods read failed: ${error.message}`)
  return ((data ?? []) as Array<{ period_end: string }>)[0]?.period_end ?? `${year}-12-31`
}

/**
 * GET /api/bolaget/owner-tax?year=YYYY: the Ägarskatt och närstående page's
 * data for an inkomstår: the K10 underlag per delägare, the owner loan
 * register (reconciled today), the 21:10 special list and the ÅRL 5:18
 * note of the year, the KU20 status, and whether the caller may download
 * KU20 (an owner or admin: the file carries personnummer). Names and masked
 * identities only.
 */
export const GET = withRouteContext('bolaget.owner_tax_get', async (request, ctx) => {
  const gate = await bolagetGateResponse(ctx)
  if (gate) return gate
  const year = readIncomeYear(request)
  if (year === null) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
  const op = operationContext(ctx)
  const balanceDate = await balanceDateOf(ctx, year)
  const [k10, loans, ku20, boardNote, isAdmin] = await Promise.all([
    loadK10Year(op, year),
    loadOwnerLoansView(op),
    loadKu20Status(op, year),
    loadBoardLoansNote(op, balanceDate),
    callerIsCompanyAdmin(ctx.supabase, ctx.user.id, ctx.companyId),
  ])
  return NextResponse.json({
    data: { year, k10, loans, special_list: specialList(loans, year), ku20, board_note: boardNote, can_download_ku20: isAdmin },
  })
})
