import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'

const BookingTemplateLineSchema = z.object({
  account: z.string().regex(/^\d{4}$/),
  label: z.string().min(1),
  side: z.enum(['debit', 'credit']),
  type: z.enum(['business', 'vat', 'settlement']),
  ratio: z.number().min(0).max(10).optional(),
  vat_rate: z.number().min(0).max(1).optional(),
})

const UpdateBookingTemplateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  category: z.enum([
    'eu_trade', 'tax_account', 'private_transfer',
    'salary', 'representation', 'year_end',
    'vat', 'financial', 'other',
  ]).optional(),
  entity_type: z.enum(['all', 'enskild_firma', 'aktiebolag']).optional(),
  lines: z.array(BookingTemplateLineSchema).min(2).optional(),
})

/**
 * PUT /api/settings/booking-templates/[id]
 * Update a non-system template.
 */
export const PUT = withRouteContext<{ params: Promise<{ id: string }> }>(
  'booking_template.update',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase } = ctx

    const result = await validateBody(request, UpdateBookingTemplateSchema)
    if (!result.success) return result.response

    // RLS prevents updating system templates
    const { data, error } = await supabase
      .from('booking_template_library')
      .update(result.data)
      .eq('id', id)
      .eq('is_system', false)
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: 'Template not found' }, { status: 404 })

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
