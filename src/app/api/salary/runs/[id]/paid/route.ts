import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'

ensureInitialized()

/** approved → paid (payment confirmation) */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.paid',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    const { data: run, error } = await supabase
      .from('salary_runs')
      .update({
        status: 'paid',
        paid_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .eq('status', 'approved')
      .select()
      .single()

    if (error || !run) {
      return NextResponse.json({ error: 'Lönekörningen måste vara godkänd' }, { status: 400 })
    }

    return NextResponse.json({ data: run })
  },
  { requireWrite: true },
)
