import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * POST /api/settings/booking-templates/[id]/hide
 *
 * Hide a system template for the current company. Opt-in and per-company:
 * nothing is hidden by default, and a hide row never affects any other
 * company. Company/team templates are excluded on purpose: they already have
 * a real delete path, and hiding them would just be a confusing second one.
 *
 * DELETE /api/settings/booking-templates/[id]/hide
 *
 * Unhide (restore) the template for the current company.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'booking_template.hide',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, user } = ctx

    // Only an existing, active SYSTEM template can be hidden. RLS on
    // booking_template_hidden scopes the write to the active company; this
    // check scopes it to the right kind of template.
    const { data: template, error: templateError } = await supabase
      .from('booking_template_library')
      .select('id, is_system, is_active')
      .eq('id', id)
      .maybeSingle()

    if (templateError) {
      return NextResponse.json({ error: getUserErrorMessage(templateError) }, { status: 500 })
    }
    if (!template || !template.is_active) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 })
    }
    if (!template.is_system) {
      return NextResponse.json({ error: 'Only system templates can be hidden' }, { status: 400 })
    }

    // ignoreDuplicates makes the conflict arm DO NOTHING. The table has no
    // UPDATE policy (insert-or-delete only), so a DO UPDATE arm would be
    // rejected by RLS and turn a concurrent re-hide into a 500.
    const { error } = await supabase
      .from('booking_template_hidden')
      .upsert(
        { template_id: id, company_id: companyId, hidden_by: user.id },
        { onConflict: 'template_id,company_id', ignoreDuplicates: true },
      )

    if (error) {
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }

    return NextResponse.json({ data: { success: true } })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'booking_template.unhide',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId } = ctx

    // Deleting a row that does not exist is a no-op success: unhide is
    // idempotent, and the panel may race a double click.
    const { error } = await supabase
      .from('booking_template_hidden')
      .delete()
      .eq('template_id', id)
      .eq('company_id', companyId)

    if (error) {
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }

    return NextResponse.json({ data: { success: true } })
  },
  { requireWrite: true },
)
