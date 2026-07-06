import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'

ensureInitialized()

/**
 * draft → review (freeze calculations)
 *
 * Per f-skatt.md: Employer must verify F-skatt status before first payment.
 * If any employee has f_skatt_status = 'not_verified', return a warning.
 * The user can still proceed but the warning is logged for audit trail.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  // Check for F-skatt verification warnings
  const { data: runEmployees } = await supabase
    .from('salary_run_employees')
    .select('employee:employees(first_name, last_name, f_skatt_status)')
    .eq('salary_run_id', id)

  const warnings: string[] = []
  for (const sre of runEmployees || []) {
    const emp = sre.employee as unknown as { first_name: string; last_name: string; f_skatt_status: string } | null
    if (emp?.f_skatt_status === 'not_verified') {
      warnings.push(
        `${emp.first_name} ${emp.last_name}: F-skatt ej verifierad: 30% skatteavdrag och fulla avgifter tillämpas (f-skatt.md)`
      )
    }
  }

  const { data: run, error } = await supabase
    .from('salary_runs')
    .update({ status: 'review' })
    .eq('id', id)
    .eq('company_id', companyId)
    .eq('status', 'draft')
    .select()
    .single()

  if (error || !run) {
    return NextResponse.json({ error: 'Lönekörningen måste vara i utkaststatus' }, { status: 400 })
  }

  return NextResponse.json({
    data: run,
    warnings: warnings.length > 0 ? warnings : undefined,
  })
}
