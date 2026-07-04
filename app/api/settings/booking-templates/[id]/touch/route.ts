import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'

/**
 * POST /api/settings/booking-templates/[id]/touch
 *
 * Record that this template was applied by the current company. Upserts the
 * (template_id, company_id) row in booking_template_usage, refreshing
 * last_used_at. Used by the template pickers to drive MRU ordering.
 *
 * Fire-and-forget from the client: errors are non-fatal.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)

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
}
