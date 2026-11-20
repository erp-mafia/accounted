import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { bolagetGateResponse, callerIsCompanyAdmin, operationContext } from '@/lib/bolaget/session'
import { loadCapitalView } from '@/lib/bolaget/capital/view'

/**
 * GET /api/bolaget/capital: the capital events page's data: dividends with
 * the split per holder, tillskott and capital changes (names and masked
 * identities only), the years that have a dividend, and whether the caller
 * may download KU31 (an owner or admin: the file carries personnummer).
 */
export const GET = withRouteContext('bolaget.capital_get', async (_request, ctx) => {
  const gate = await bolagetGateResponse(ctx)
  if (gate) return gate
  const [view, isAdmin] = await Promise.all([loadCapitalView(operationContext(ctx)), callerIsCompanyAdmin(ctx.supabase, ctx.user.id, ctx.companyId)])
  const years = [...new Set(view.dividends.filter((d) => d.status !== 'cancelled').map((d) => Number(d.payment_date.slice(0, 4))))].sort((a, b) => b - a)
  return NextResponse.json({ data: { ...view, dividend_years: years, can_download_ku31: isAdmin } })
})
