import { BookingTemplateLineSchema, BookingTemplateCategorySchema, BookingTemplateEntityTypeSchema } from '@/lib/bookkeeping/booking-template-schemas'
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { sparsePatchBody } from '@/lib/api/sparse-patch'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

const UpdateBookingTemplateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  category: BookingTemplateCategorySchema.optional(),
  entity_type: BookingTemplateEntityTypeSchema.optional(),
  lines: z.array(BookingTemplateLineSchema).min(2).optional(),
})

/**
 * PUT /api/settings/booking-templates/[id]
 * Update a non-system template belonging to the active company (or its team).
 */
export const PUT = withRouteContext<{ params: Promise<{ id: string }> }>(
  'booking_template.update',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId } = ctx

    // result.data is spread straight into .update(), so it must carry only the
    // fields the caller named. UpdateBookingTemplateSchema has no .default()
    // today; sparsePatchBody makes that a structural property rather than a
    // thing a future edit to the schema can quietly undo.
    const result = await validateBody(request, sparsePatchBody(UpdateBookingTemplateSchema))
    if (!result.success) return result.response

    // Read the template first so a missing row is a clean 404: .single() on
    // the update chain reported zero rows as a PGRST116 ERROR, which fell into
    // the 500 branch and left the 404 below unreachable.
    const { data: existing, error: fetchError } = await supabase
      .from('booking_template_library')
      .select('id, company_id, team_id, is_system')
      .eq('id', id)
      .maybeSingle()

    if (fetchError) {
      return NextResponse.json({ error: getUserErrorMessage(fetchError) }, { status: 500 })
    }
    // System templates are never editable (customize duplicates them instead);
    // reported as not-found rather than forbidden, matching the RLS view.
    if (!existing || existing.is_system) {
      return NextResponse.json({ error: 'Mallen hittades inte' }, { status: 404 })
    }

    // Defense in depth alongside RLS (which is membership-wide): only
    // templates scoped to the ACTIVE company, or shared with its team, are
    // editable in this context. Without this, a user who belongs to several
    // companies could edit company B's template while acting in company A.
    // Team templates carry company_id NULL, so a plain company_id filter on
    // the update would break them: check the applicable scope explicitly.
    if (existing.company_id) {
      if (existing.company_id !== companyId) {
        return NextResponse.json({ error: 'Mallen hittades inte' }, { status: 404 })
      }
    } else if (existing.team_id) {
      const { data: company } = await supabase
        .from('companies')
        .select('team_id')
        .eq('id', companyId)
        .maybeSingle()
      if (!company?.team_id || company.team_id !== existing.team_id) {
        return NextResponse.json({ error: 'Mallen hittades inte' }, { status: 404 })
      }
    } else {
      // Non-system template with neither company nor team scope should not
      // exist; refuse rather than let anyone edit an orphan.
      return NextResponse.json({ error: 'Mallen hittades inte' }, { status: 404 })
    }

    // RLS prevents updating system templates; is_system is re-checked here so
    // the guard holds even on a service-role client.
    const { data, error } = await supabase
      .from('booking_template_library')
      .update(result.data)
      .eq('id', id)
      .eq('is_system', false)
      .select()
      .maybeSingle()

    if (error) return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    // The row can vanish between the scope check and the update.
    if (!data) return NextResponse.json({ error: 'Mallen hittades inte' }, { status: 404 })

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
