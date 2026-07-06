import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateDeadlineSchema } from '@/lib/api/schemas'

// Sparse update: every Create field, optional. Validated — the previous
// implementation type-asserted the raw JSON, so malformed values reached
// Postgres and malformed JSON crashed the handler.
const UpdateDeadlineSchema = CreateDeadlineSchema.partial()

/**
 * GET /api/deadlines/[id]
 * Get a single deadline by ID
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'deadline.get',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId } = ctx

    const { data, error } = await supabase
      .from('deadlines')
      .select('*, customer:customers(id, name)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Deadline not found' }, { status: 404 })
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data })
  },
)

/**
 * PUT /api/deadlines/[id]
 * Update a deadline
 */
export const PUT = withRouteContext<{ params: Promise<{ id: string }> }>(
  'deadline.update',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, log } = ctx

    const validation = await validateBody(request, UpdateDeadlineSchema, {
      log,
      operation: 'deadline.update',
    })
    if (!validation.success) return validation.response
    const body = validation.data

    // Build update object
    const updateData: Record<string, unknown> = {}
    if (body.title !== undefined) updateData.title = body.title
    if (body.due_date !== undefined) updateData.due_date = body.due_date
    if (body.due_time !== undefined) updateData.due_time = body.due_time
    if (body.deadline_type !== undefined) updateData.deadline_type = body.deadline_type
    if (body.priority !== undefined) updateData.priority = body.priority
    if (body.customer_id !== undefined) updateData.customer_id = body.customer_id || null
    if (body.notes !== undefined) updateData.notes = body.notes

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('deadlines')
      .update(updateData)
      .eq('id', id)
      .eq('company_id', companyId)
      .select('*, customer:customers(id, name)')
      .single()

    if (error) {
      // PGRST116 = zero rows — the deadline doesn't exist in this company.
      if (error.code === 'PGRST116') {
        return NextResponse.json({ error: 'Deadline not found' }, { status: 404 })
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)

/**
 * DELETE /api/deadlines/[id]
 * Delete a deadline
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'deadline.delete',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId } = ctx

    const { error, count } = await supabase
      .from('deadlines')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('company_id', companyId)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    // Zero rows = wrong id / another company's deadline — not a success.
    if (count === 0) {
      return NextResponse.json({ error: 'Deadline not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
