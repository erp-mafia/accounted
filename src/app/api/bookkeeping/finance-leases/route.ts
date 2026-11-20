import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { financeLeaseEnabled } from '@/lib/env/finance-lease-switch'
import {
  createFinanceLease,
  financeLeaseCapitalisationChosen,
  leaseFromRow,
  listFinanceLeases,
} from '@/lib/bokslut/leasing/register'
import { leaseSchedule } from '@/lib/bokslut/leasing/finance-lease'
import { CreateFinanceLeaseSchema } from '@/lib/bokslut/leasing/schemas'

/**
 * GET /api/bookkeeping/finance-leases: the lessee's finansiella leasingavtal
 * with their recognised amounts, and whether the company has chosen
 * capitalisation (K3 20.5) over the 20.29 relief. Behind
 * NEXT_PUBLIC_FINANCE_LEASE_ENABLED.
 */
export const GET = withRouteContext('bookkeeping.finance-leases.list', async (_request, ctx) => {
  if (!financeLeaseEnabled()) return errorResponseFromCode('FINANCE_LEASE_DISABLED', ctx.log, { requestId: ctx.requestId })
  const [rows, chosen] = await Promise.all([
    listFinanceLeases(ctx.supabase, ctx.companyId),
    financeLeaseCapitalisationChosen(ctx.supabase, ctx.companyId),
  ])
  const leases = rows.map((row) => {
    const schedule = leaseSchedule(leaseFromRow(row))
    return {
      ...row,
      initial_asset: schedule.initialAsset,
      initial_liability: schedule.initialLiability,
      depreciation_months: schedule.depreciationMonths,
    }
  })
  return NextResponse.json({ data: { capitalisation_chosen: chosen, leases } })
})

/** POST /api/bookkeeping/finance-leases: register a finansiellt leasingavtal. */
export const POST = withRouteContext(
  'bookkeeping.finance-leases.create',
  async (request, ctx) => {
    if (!financeLeaseEnabled()) return errorResponseFromCode('FINANCE_LEASE_DISABLED', ctx.log, { requestId: ctx.requestId })
    const body = await validateBody(request, CreateFinanceLeaseSchema, {
      log: ctx.log,
      operation: 'bookkeeping.finance-leases.create',
    })
    if (!body.success) return body.response
    const row = await createFinanceLease(ctx.supabase, ctx.companyId, ctx.user.id, body.data)
    return NextResponse.json({ data: row }, { status: 201 })
  },
  { requireWrite: true },
)
