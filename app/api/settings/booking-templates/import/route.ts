import { BookingTemplateLineSchema, BookingTemplateCategorySchema, BookingTemplateEntityTypeSchema } from '@/lib/bookkeeping/booking-template-schemas'
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { z } from 'zod'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

const ImportTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  category: BookingTemplateCategorySchema.default('other'),
  entity_type: BookingTemplateEntityTypeSchema.default('all'),
  lines: z.array(BookingTemplateLineSchema).min(2),
})

const ImportPayloadSchema = z.object({
  version: z.number(),
  templates: z.array(ImportTemplateSchema).min(1).max(100),
})

/**
 * POST /api/settings/booking-templates/import
 * Import templates from JSON (exported from another company).
 * Creates company-scoped templates for the active company.
 */
export const POST = withRouteContext(
  'booking_template.import',
  async (request, ctx) => {
    const { supabase, user, companyId } = ctx

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const parsed = ImportPayloadSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid import format', details: parsed.error.issues },
        { status: 400 },
      )
    }

    const rows = parsed.data.templates.map((t) => ({
      company_id: companyId,
      team_id: null,
      created_by: user.id,
      name: t.name,
      description: t.description,
      category: t.category,
      entity_type: t.entity_type,
      lines: t.lines,
      is_system: false,
    }))

    const { data, error } = await supabase
      .from('booking_template_library')
      .insert(rows)
      .select()

    if (error) return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })

    return NextResponse.json({ data, imported: data?.length ?? 0 }, { status: 201 })
  },
  { requireWrite: true },
)
