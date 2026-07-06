import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'

// POST /api/agent/profile/verify
//
// Stamps verified_at + verified_by_user_id on agent_profiles when the user
// clicks "Det här ser rätt ut, kör" in Phase B. Idempotent: re-verifying
// updates the timestamp; this is desirable for "Bygg om" rebuild flows.

const BodySchema = z.object({
  company_id: z.string().uuid().optional(),
})

export const POST = withRouteContext('agent.profile.verify', async (request, ctx) => {
  const { supabase, companyId: activeCompanyId, user } = ctx

  // Tolerant parse: the review card POSTs with an empty body when verifying
  // the active company.
  const raw = await request.json().catch(() => ({}))
  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'Validation failed',
        type: 'validation_error',
        errors: parsed.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      },
      { status: 400 },
    )
  }

  const companyId = parsed.data.company_id ?? activeCompanyId

  // Defense in depth alongside RLS: confirm membership for the target
  // company; a non-viewer role is required to stamp verified_at.
  const { data: membership } = await supabase
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership || membership.role === 'viewer') {
    return NextResponse.json(
      {
        error: {
          code: 'WRITE_PERMISSION_REQUIRED',
          message: 'Du har endast läsbehörighet i detta företag.',
          message_en: 'You only have read access in this company.',
        },
      },
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
  if (error) throw error

  return NextResponse.json({ data })
})
