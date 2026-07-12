import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateSalaryLineItemSchema } from '@/lib/api/schemas'

ensureInitialized()

export const PATCH = withRouteContext<{ params: Promise<{ id: string; lineId: string }> }>(
  'salary.run.line.update',
  async (request, ctx, { params }) => {
    const { id, lineId } = await params
    const { supabase, companyId } = ctx

    // Verify run is draft
    const { data: run } = await supabase
      .from('salary_runs')
      .select('id, status')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (!run) return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
    if (run.status !== 'draft') return NextResponse.json({ error: 'Kan bara redigera utkast' }, { status: 400 })

    const validation = await validateBody(request, UpdateSalaryLineItemSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    // Round amount if provided
    const updates = { ...body }
    if (updates.amount !== undefined) {
      updates.amount = Math.round(updates.amount * 100) / 100
    }

    const { data: updated, error } = await supabase
      .from('salary_line_items')
      .update(updates)
      .eq('id', lineId)
      .eq('company_id', companyId)
      .select()
      .single()

    if (error || !updated) {
      return NextResponse.json({ error: 'Rad hittades inte' }, { status: 404 })
    }

    return NextResponse.json({ data: updated })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext<{ params: Promise<{ id: string; lineId: string }> }>(
  'salary.run.line.delete',
  async (_request, ctx, { params }) => {
    const { id, lineId } = await params
    const { supabase, companyId } = ctx

    // Verify run is draft
    const { data: run } = await supabase
      .from('salary_runs')
      .select('id, status')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (!run) return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
    if (run.status !== 'draft') return NextResponse.json({ error: 'Kan bara redigera utkast' }, { status: 400 })

    const { error } = await supabase
      .from('salary_line_items')
      .delete()
      .eq('id', lineId)
      .eq('company_id', companyId)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data: { deleted: true } })
  },
  { requireWrite: true },
)
