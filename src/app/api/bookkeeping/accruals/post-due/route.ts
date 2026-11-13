import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { postDueInstallments } from '@/lib/bookkeeping/accruals/service'

/**
 * POST /api/bookkeeping/accruals/post-due
 *
 * Manual "Bokför förfallna periodiseringar" for the active company:
 * complements the daily cron (same service, so the same one-transaction
 * posting of a month: a click during the cron's run posts nothing twice), so the
 * user never has to wait for the nightly run after creating a schedule with
 * elapsed months or after fixing a blocked installment.
 */
export const POST = withRouteContext(
  'accruals.post_due',
  async (_request, ctx) => {
    const { user, supabase, companyId } = ctx

    const result = await postDueInstallments(supabase, companyId!, {
      userId: user.id,
    })

    return NextResponse.json({ data: result })
  },
  { requireWrite: true },
)
