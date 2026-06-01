import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { validateBody } from '@/lib/api/validate'
import { CreateCostCenterSchema } from '@/lib/api/schemas'

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)

  // The calendar picker wants active centers only; the settings manager passes
  // ?include_inactive=true to list everything for editing.
  const includeInactive = new URL(request.url).searchParams.get('include_inactive') === 'true'

  let query = supabase
    .from('cost_centers')
    .select('id, code, name, is_active')
    .eq('company_id', companyId)
    .order('code', { ascending: true })

  if (!includeInactive) query = query.eq('is_active', true)

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data: data ?? [] })
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const validation = await validateBody(request, CreateCostCenterSchema)
  if (!validation.success) return validation.response

  const { data, error } = await supabase
    .from('cost_centers')
    .insert({
      company_id: companyId,
      // Legacy NOT NULL column kept by the multi-tenant refactor — records the
      // creator; tenant scoping is enforced via company_id + RLS.
      user_id: user.id,
      code: validation.data.code,
      name: validation.data.name,
    })
    .select('id, code, name, is_active')
    .single()

  if (error) {
    // Unique (company_id, code) violation → friendly 409.
    if (error.code === '23505') {
      return NextResponse.json(
        { error: 'Ett kostnadsställe med den koden finns redan' },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data }, { status: 201 })
}
