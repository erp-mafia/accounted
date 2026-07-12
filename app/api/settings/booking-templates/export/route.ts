import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'

/**
 * GET /api/settings/booking-templates/export
 * Export company + team templates as JSON (excludes system templates).
 * Useful for sharing templates between unrelated companies.
 */
export const GET = withRouteContext(
  'booking_template.export',
  async (_request, ctx) => {
    const { supabase, companyId } = ctx

    const { data, error } = await supabase
      .from('booking_template_library')
      .select('name, description, category, entity_type, lines')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .eq('is_system', false)
      .order('category')
      .order('name')

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return new NextResponse(JSON.stringify({ version: 1, templates: data }, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="bokforingsmallar.json"',
      },
    })
  },
)
