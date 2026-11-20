import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { financeLeaseEnabled } from '@/lib/env/finance-lease-switch'
import { FinanceLeaseError, bookFinanceLeaseYear } from '@/lib/bokslut/leasing/register'
import { BookFinanceLeaseYearSchema } from '@/lib/bokslut/leasing/schemas'

/**
 * POST /api/bookkeeping/finance-leases/book: book one financial year of the
 * lessee's finansiella leasingavtal: the start of each lease that begins in
 * it (asset and liability, K3 20.5) and the year-end adjustment (20.9, 20.11).
 * Once per year; refused until the company has chosen capitalisation.
 */
export const POST = withRouteContext(
  'bookkeeping.finance-leases.book',
  async (request, ctx) => {
    if (!financeLeaseEnabled()) return errorResponseFromCode('FINANCE_LEASE_DISABLED', ctx.log, { requestId: ctx.requestId })
    const body = await validateBody(request, BookFinanceLeaseYearSchema, {
      log: ctx.log,
      operation: 'bookkeeping.finance-leases.book',
    })
    if (!body.success) return body.response
    try {
      const result = await bookFinanceLeaseYear(ctx.supabase, ctx.companyId, ctx.user.id, body.data.fiscal_period_id)
      const voucher = (entry: { id: string; voucher_series?: string | null; voucher_number?: number | null }) => ({
        journal_entry_id: entry.id,
        voucher_series: entry.voucher_series ?? null,
        voucher_number: entry.voucher_number ?? null,
      })
      return NextResponse.json({
        data: {
          initial_entries: result.initialEntries.map(voucher),
          year_end_entry: result.yearEndEntry ? voucher(result.yearEndEntry) : null,
        },
      })
    } catch (err) {
      if (err instanceof FinanceLeaseError) {
        return errorResponseFromCode(err.code, ctx.log, { requestId: ctx.requestId, details: err.details })
      }
      throw err
    }
  },
  { requireWrite: true },
)
