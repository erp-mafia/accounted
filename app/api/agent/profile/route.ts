import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getActiveCompanyId } from '@/lib/company/context'

// GET /api/agent/profile?company_id=...
// PATCH same path
//
// GET returns the composed profile + the source verification_questions stored
// alongside it (read from agent_profiles row).
//
// PATCH updates field_overrides (timestamped, merged with existing) and
// optionally rewrites the atom arrays from the review UI. Does not touch
// verified_at: that flows through /verify.

const AtomArrays = z.object({
  horizontal_atoms: z.array(z.string()).optional(),
  vertical_atoms: z.array(z.string()).optional(),
  modifier_atoms: z.array(z.string()).optional(),
})

const PatchBody = z.object({
  company_id: z.string().uuid().optional(),
  field_overrides: z.record(z.string(), z.unknown()).optional(),
  atoms: AtomArrays.optional(),
  profile_summary: z.string().min(1).max(2000).optional(),
  // Agent personalization: name shown on the FAB and chat headers, and
  // avatar key into the static AVATAR_OPTIONS registry. Both nullable so
  // the user can clear them back to defaults.
  display_name: z.string().min(1).max(60).nullable().optional(),
  avatar_id: z.string().max(60).nullable().optional(),
})

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(request.url)
  const companyId =
    url.searchParams.get('company_id') ?? (await getActiveCompanyId(supabase, user.id))
  if (!companyId) return NextResponse.json({ error: 'No active company' }, { status: 400 })

  // Defense in depth alongside RLS: confirm membership before reading.
  const { data: membership } = await supabase
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { data, error } = await supabase
    .from('agent_profiles')
    .select(
      'company_id, horizontal_atoms, vertical_atoms, modifier_atoms, profile_summary, source_signals, field_overrides, composed_at, composer_model, composer_version, verified_at, verified_by_user_id, display_name, avatar_id',
    )
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ data: null })

  return NextResponse.json({ data })
}

export async function PATCH(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: z.infer<typeof PatchBody>
  try {
    body = PatchBody.parse(await request.json())
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid body' },
      { status: 400 },
    )
  }

  const companyId = body.company_id ?? (await getActiveCompanyId(supabase, user.id))
  if (!companyId) return NextResponse.json({ error: 'No active company' }, { status: 400 })

  // RLS guards reads/updates by company_id; defense in depth: confirm membership.
  const { data: membership } = await supabase
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Load current overrides to merge timestamp-stamped entries. Avoids round-trip
  // when caller sends only an atom-array change.
  const { data: current } = await supabase
    .from('agent_profiles')
    .select('field_overrides')
    .eq('company_id', companyId)
    .single()
  if (!current) {
    return NextResponse.json({ error: 'agent_profile not found for this company' }, { status: 404 })
  }

  const update: Record<string, unknown> = {}
  if (body.field_overrides && Object.keys(body.field_overrides).length > 0) {
    const merged: Record<string, { value: unknown; overridden_at: string }> = {
      ...((current.field_overrides as Record<string, { value: unknown; overridden_at: string }>) ?? {}),
    }
    const now = new Date().toISOString()
    for (const [k, v] of Object.entries(body.field_overrides)) {
      merged[k] = { value: v, overridden_at: now }
    }
    update.field_overrides = merged
  }
  if (body.atoms?.horizontal_atoms) update.horizontal_atoms = body.atoms.horizontal_atoms
  if (body.atoms?.vertical_atoms) update.vertical_atoms = body.atoms.vertical_atoms
  if (body.atoms?.modifier_atoms) update.modifier_atoms = body.atoms.modifier_atoms
  if (body.profile_summary) update.profile_summary = body.profile_summary
  if (body.display_name !== undefined) update.display_name = body.display_name
  if (body.avatar_id !== undefined) update.avatar_id = body.avatar_id

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('agent_profiles')
    .update(update)
    .eq('company_id', companyId)
    .select(
      'company_id, horizontal_atoms, vertical_atoms, modifier_atoms, profile_summary, field_overrides',
    )
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data })
}
