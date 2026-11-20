import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { financeLeaseEnabled } from '@/lib/env/finance-lease-switch'
import { FinanceLeaseError, getFinanceLease } from '@/lib/bokslut/leasing/register'

/**
 * GET /api/bookkeeping/finance-leases/[id]: one finansiellt leasingavtal and
 * its schedule (each payment split into interest and amortisation, K3 20.9).
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.finance-leases.get',
  async (_request, ctx, { params }) => {
    if (!financeLeaseEnabled()) return errorResponseFromCode('FINANCE_LEASE_DISABLED', ctx.log, { requestId: ctx.requestId })
    const { id } = await params
    try {
      const { row, schedule } = await getFinanceLease(ctx.supabase, ctx.companyId, id)
      return NextResponse.json({
        data: {
          lease: row,
          schedule: {
            initial_asset: schedule.initialAsset,
            initial_liability: schedule.initialLiability,
            depreciation_months: schedule.depreciationMonths,
            rows: schedule.rows.map((r) => ({
              index: r.index,
              date: r.date,
              payment: r.payment,
              interest: r.interest,
              amortisation: r.amortisation,
              liability: r.liability,
            })),
          },
        },
      })
    } catch (err) {
      if (err instanceof FinanceLeaseError) {
        return errorResponseFromCode(err.code, ctx.log, { requestId: ctx.requestId, details: err.details })
      }
      throw err
    }
  },
)
