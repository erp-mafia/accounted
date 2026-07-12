import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'

/**
 * POST /api/settings/booking-templates/[id]/touch
 *
 * Record that this template was applied by the current company. Upserts the
 * (template_id, company_id) row in booking_template_usage, refreshing
 * last_used_at. Used by the template pickers to drive MRU ordering.
 *
 * Fire-and-forget from the client: errors are non-fatal.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'booking_template.touch',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId } = ctx

    const { error } = await supabase
      .from('booking_template_usage')
      .upsert(
        {
          template_id: id,
          company_id: companyId,
          last_used_at: new Date().toISOString(),
        },
        { onConflict: 'template_id,company_id' },
      )

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data: { success: true } })
  },
  { requireWrite: true },
)
