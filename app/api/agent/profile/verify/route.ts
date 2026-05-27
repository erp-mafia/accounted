import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getActiveCompanyId } from '@/lib/company/context'

// POST /api/agent/profile/verify
//
// Stamps verified_at + verified_by_user_id on agent_profiles when the user
// clicks "Det här ser rätt ut — kör" in Phase B. Idempotent: re-verifying
// updates the timestamp; this is desirable for "Bygg om" rebuild flows.

const BodySchema = z.object({
  company_id: z.string().uuid().optional(),
})

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: z.infer<typeof BodySchema>
  try {
    body = BodySchema.parse(await request.json().catch(() => ({})))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid body' },
      { status: 400 },
    )
  }

  const companyId = body.company_id ?? (await getActiveCompanyId(supabase, user.id))
  if (!companyId) return NextResponse.json({ error: 'No active company' }, { status: 400 })

  // Defense in depth alongside RLS — confirm membership for the target
  // company; a non-viewer role is required to stamp verified_at.
  const { data: membership } = await supabase
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership || membership.role === 'viewer') {
    return NextResponse.json(
      { error: 'Du har endast läsbehörighet i detta företag.' },
      { status: 403 },
    )
  }

  const { data, error } = await supabase
    .from('agent_profiles')
    .update({
      verified_at: new Date().toISOString(),
      verified_by_user_id: user.id,
    })
    .eq('company_id', companyId)
    .select('company_id, verified_at, verified_by_user_id')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data })
}
