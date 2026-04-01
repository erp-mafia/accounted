import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { validatePeriodDuration } from '@/lib/bookkeeping/validate-period-duration'
import { validateBody } from '@/lib/api/validate'
import { CreateFiscalPeriodSchema } from '@/lib/api/schemas'
import { requireCompanyId } from '@/lib/company/context'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('company_id', companyId)
    .order('period_start', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const validation = await validateBody(request, CreateFiscalPeriodSchema)
  if (!validation.success) return validation.response
  const body = validation.data

  // Validate period duration (max 18 months per BFL 3 kap.)
  const durationError = validatePeriodDuration(body.period_start, body.period_end)
  if (durationError) {
    return NextResponse.json({ error: durationError }, { status: 400 })
  }

  // Enforce continuity: new period must chain from the latest existing period (BFL 3:1)
  const { data: latest } = await supabase
    .from('fiscal_periods')
    .select('period_end, is_closed')
    .eq('company_id', companyId)
    .order('period_end', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (latest) {
    const prev = new Date(latest.period_end + 'T00:00:00')
    prev.setDate(prev.getDate() + 1)
    const expectedStart = prev.toISOString().split('T')[0]
    if (body.period_start !== expectedStart) {
      return NextResponse.json(
        { error: `Period must start on ${expectedStart} (day after latest period ends)` },
        { status: 400 }
      )
    }
  }

  // Enforce: max one unclosed period (no skipping ahead)
  const { count: openCount } = await supabase
    .from('fiscal_periods')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('is_closed', false)

  if (openCount && openCount > 0) {
    return NextResponse.json(
      { error: 'Cannot create a new period while an unclosed period exists' },
      { status: 409 }
    )
  }

  // Defense-in-depth: check for overlapping periods
  const { data: overlapping } = await supabase
    .from('fiscal_periods')
    .select('id, name')
    .eq('company_id', companyId)
    .lte('period_start', body.period_end)
    .gte('period_end', body.period_start)
    .limit(1)

  if (overlapping && overlapping.length > 0) {
    return NextResponse.json(
      { error: `Overlaps with existing period: ${overlapping[0].name}` },
      { status: 409 }
    )
  }

  const { data, error } = await supabase
    .from('fiscal_periods')
    .insert({
      user_id: user.id,
      company_id: companyId,
      name: body.name,
      period_start: body.period_start,
      period_end: body.period_end,
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}
