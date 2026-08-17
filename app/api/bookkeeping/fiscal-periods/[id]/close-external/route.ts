import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { markPeriodClosedExternally } from '@/lib/core/bookkeeping/period-service'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

// "Klarmarkera": mark an imported historical year as closed in a previous
// bookkeeping system. Same legacy `{ error: string }` failure shape as the
// sibling close route: the year-end UI reads it directly.
export const POST = withRouteContext(
  'period.close_external',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId } = ctx

    try {
      const period = await markPeriodClosedExternally(supabase, companyId, user.id, id)
      return NextResponse.json({ data: period })
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? getUserErrorMessage(err) : 'Failed to mark period as closed' },
        { status: 400 }
      )
    }
  },
  { requireWrite: true },
)
