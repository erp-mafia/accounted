import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { postDueInstallments } from '@/lib/bookkeeping/accruals/service'

ensureInitialized()

/**
 * POST /api/bookkeeping/accruals/post-due
 *
 * Manual "Bokför förfallna periodiseringar" for the active company:
 * complements the daily cron (same service, same CAS idempotency), so the
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
