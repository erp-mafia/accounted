import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'

ensureInitialized()

/** review → draft (unlock for editing) */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.revert',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    const { data: run, error } = await supabase
      .from('salary_runs')
      .update({ status: 'draft' })
      .eq('id', id)
      .eq('company_id', companyId)
      .eq('status', 'review')
      .select()
      .single()

    if (error || !run) {
      return NextResponse.json({ error: 'Lönekörningen måste vara i granskningsstatus' }, { status: 400 })
    }

    return NextResponse.json({ data: run })
  },
  { requireWrite: true },
)
