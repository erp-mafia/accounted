import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'

/**
 * POST /api/deadlines/[id]/complete
 * Toggle completion status of a deadline
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'deadline.toggle_complete',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId } = ctx

    // First, get current deadline state
    const { data: existing, error: fetchError } = await supabase
      .from('deadlines')
      .select('is_completed')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return NextResponse.json({ error: 'Deadline not found' }, { status: 404 })
      }
      return NextResponse.json({ error: fetchError.message }, { status: 500 })
    }

    // Toggle completion
    const newCompletedState = !existing.is_completed
    const { data, error } = await supabase
      .from('deadlines')
      .update({
        is_completed: newCompletedState,
        completed_at: newCompletedState ? new Date().toISOString() : null,
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .select('*, customer:customers(id, name)')
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
