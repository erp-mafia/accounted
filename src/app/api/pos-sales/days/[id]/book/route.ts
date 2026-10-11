import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { bookPosSalesDay } from '@/lib/pos-sales/book-day'
import { PosBookBodySchema } from '@/lib/pos-sales/schemas'

// The engine emits journal_entry.committed: wire the handlers first.
ensureInitialized()

/**
 * Book one POS day as its daily takings voucher, with the day report as
 * underlag. The lines are the server's, from the stored day and the
 * connection's mapping; expected_raw_sha256 pins the version of the day the
 * person reviewed. Rules in lib/pos-sales/book-day.ts, shared with the
 * operation pos-sales.day-book.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'pos_sales.day.book',
  async (request, ctx, { params }) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const { id } = await params
    const body = await validateBody(request, PosBookBodySchema, { log, operation: 'pos_sales.day.book' })
    if (!body.success) return body.response
    const opLog = log.child({ dayId: id })
    const outcome = await bookPosSalesDay({ supabase, companyId: companyId!, userId: user.id, log: opLog }, { day_id: id, ...body.data })
    if (!outcome.ok) return sessionFailureResponse(outcome, opLog, requestId)
    if (outcome.dryRun) throw new Error('unreachable: no dry run on the dashboard')
    return NextResponse.json({ data: outcome.data, ...(outcome.warnings ? { warnings: outcome.warnings } : {}) })
  },
  { requireWrite: true },
)
