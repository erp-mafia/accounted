import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'

export const GET = withRouteContext(
  'counterparty_template.list',
  async (_request, { supabase, companyId }) => {
    const { data, error } = await supabase
      .from('categorization_templates')
      .select('*')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .order('occurrence_count', { ascending: false })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ data })
  },
)

export const DELETE = withRouteContext(
  'counterparty_template.delete',
  async (request, { supabase, companyId }) => {
    let id: string | undefined
    try {
      const body = await request.json()
      id = body?.id
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

    const { error } = await supabase
      .from('categorization_templates')
      .update({ is_active: false })
      .eq('id', id)
      .eq('company_id', companyId)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ data: { success: true } })
  },
  { requireWrite: true },
)
