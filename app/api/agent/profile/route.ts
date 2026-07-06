import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'

// GET /api/agent/profile?company_id=...
// PATCH same path
//
// GET returns the composed profile + the source verification_questions stored
// alongside it (read from agent_profiles row).
//
// PATCH updates field_overrides (timestamped, merged with existing) and
// optionally rewrites the atom arrays from the review UI. Does not touch
// verified_at: that flows through /verify. Requires a non-viewer role in
// the target company (same rule as /verify: it mutates the profile).

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

const GetQuerySchema = z.object({
  company_id: z.string().uuid().optional(),
})

const forbidden = (code: 'NOT_COMPANY_MEMBER' | 'WRITE_PERMISSION_REQUIRED') =>
  NextResponse.json(
    {
      error:
        code === 'NOT_COMPANY_MEMBER'
          ? {
              code,
              message: 'Du är inte medlem i detta företag.',
              message_en: 'Not a member of this company.',
            }
          : {
              code,
              message: 'Du har endast läsbehörighet i detta företag.',
              message_en: 'You only have read access in this company.',
            },
    },
    { status: 403 },
  )

export const GET = withRouteContext('agent.profile.get', async (request, ctx) => {
  const { supabase, companyId: activeCompanyId, user, log } = ctx

  const validated = validateQuery(request, GetQuerySchema, {
    log,
    operation: 'agent.profile.get',
  })
  if (!validated.success) return validated.response
  const companyId = validated.data.company_id ?? activeCompanyId

  // Defense in depth alongside RLS: confirm membership before reading.
  const { data: membership } = await supabase
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return forbidden('NOT_COMPANY_MEMBER')

  const { data, error } = await supabase
    .from('agent_profiles')
    .select(
      'company_id, horizontal_atoms, vertical_atoms, modifier_atoms, profile_summary, source_signals, field_overrides, composed_at, composer_model, composer_version, verified_at, verified_by_user_id, display_name, avatar_id',
    )
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  if (!data) return NextResponse.json({ data: null })

  return NextResponse.json({ data })
})

export const PATCH = withRouteContext('agent.profile.update', async (request, ctx) => {
  const { supabase, companyId: activeCompanyId, user, log } = ctx

  const validation = await validateBody(request, PatchBody, {
    log,
    operation: 'agent.profile.update',
  })
  if (!validation.success) return validation.response
  const body = validation.data

  const companyId = body.company_id ?? activeCompanyId

  // RLS guards reads/updates by company_id; defense in depth: confirm
  // membership AND a non-viewer role (this mutates the company's profile;
  // same rule /verify already enforces).
  const { data: membership } = await supabase
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership) return forbidden('NOT_COMPANY_MEMBER')
  if (membership.role === 'viewer') return forbidden('WRITE_PERMISSION_REQUIRED')

  // Load current overrides to merge timestamp-stamped entries. Avoids round-trip
  // when caller sends only an atom-array change.
  const { data: current } = await supabase
    .from('agent_profiles')
    .select('field_overrides')
    .eq('company_id', companyId)
    .single()
  if (!current) {
    return NextResponse.json(
      {
        error: {
          code: 'AGENT_PROFILE_NOT_FOUND',
          message: 'Det finns ingen agentprofil för detta företag.',
          message_en: 'agent_profile not found for this company.',
        },
      },
      { status: 404 },
    )
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
    return NextResponse.json(
      {
        error: {
          code: 'NOTHING_TO_UPDATE',
          message: 'Inget att uppdatera.',
          message_en: 'Nothing to update.',
        },
      },
      { status: 400 },
    )
  }

  const { data, error } = await supabase
    .from('agent_profiles')
    .update(update)
    .eq('company_id', companyId)
    .select(
      'company_id, horizontal_atoms, vertical_atoms, modifier_atoms, profile_summary, field_overrides',
    )
    .single()
  if (error) throw error

  return NextResponse.json({ data })
})
