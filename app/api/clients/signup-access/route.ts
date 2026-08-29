import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { getByraMembership } from '@/lib/clients/fetch-client-overview'
import { clearBrandCache, resolveBrandForTeam, type Brand } from '@/lib/branding/resolve'
import type { SupabaseClient } from '@supabase/supabase-js'
import { validateBody } from '@/lib/api/validate'
import {
  BrandAllowlistAddSchema,
  BrandAllowlistRemoveSchema,
  BrandSignupModeSchema,
} from '@/lib/api/schemas'

/**
 * /api/clients/signup-access: the byrå cockpit's management surface for
 * invite-only signup on the team's brand domain (2026-08-27).
 *
 *   GET    signup mode + allowlist entries (any byrå team member)
 *   PATCH  { signup_mode }    flip open/invite_only        (owner/admin)
 *   POST   { email, note? }   add an allowlist entry       (owner/admin)
 *   DELETE { id }             remove an allowlist entry    (owner/admin)
 *
 * Uses requireAuth() directly (the sanctioned withRouteContext opt-out, MFA
 * still enforced): byrå staff without a company of their own are the
 * cockpit's primary persona, and this surface needs no active company.
 *
 * Allowlist reads/writes go through the caller's client so RLS enforces the
 * same team/role rules a second time. The signup_mode flip uses the service
 * client because brands rows are ops-managed (no user write policies); the
 * owner/admin check here is the authorization for that single column.
 */

type Access =
  | {
      ok: true
      supabase: SupabaseClient
      userId: string
      role: 'owner' | 'admin' | 'member'
      brand: Brand
    }
  | { ok: false; response: NextResponse }

async function resolveAccess(opts: { write: boolean }): Promise<Access> {
  const auth = await requireAuth()
  if (auth.error) return { ok: false, response: auth.error }
  const { user, supabase } = auth

  const membership = await getByraMembership(supabase, user.id)
  if (!membership) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: {
            code: 'FORBIDDEN',
            message: 'Endast byråteam har åtkomst till registreringsinställningarna.',
            message_en: 'Signup access settings are only available to byrå teams.',
          },
        },
        { status: 403 },
      ),
    }
  }

  if (opts.write && membership.role !== 'owner' && membership.role !== 'admin') {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: {
            code: 'FORBIDDEN',
            message: 'Endast byråns ägare och administratörer kan ändra registreringsåtkomst.',
            message_en: 'Only byrå owners and admins can change signup access.',
          },
        },
        { status: 403 },
      ),
    }
  }

  const brand = await resolveBrandForTeam(membership.teamId)
  if (!brand) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: {
            code: 'NOT_FOUND',
            message: 'Byrån har ingen egen domän ännu.',
            message_en: 'The byrå has no white-label domain yet.',
          },
        },
        { status: 404 },
      ),
    }
  }

  return { ok: true, supabase, userId: user.id, role: membership.role, brand }
}

export async function GET() {
  const access = await resolveAccess({ write: false })
  if (!access.ok) return access.response

  const { data: entries, error } = await access.supabase
    .from('brand_signup_allowlist')
    .select('id, email, note, created_at')
    .eq('brand_id', access.brand.id)
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Kunde inte hämta listan.', message_en: 'Could not load the list.' } },
      { status: 500 },
    )
  }

  return NextResponse.json({
    data: {
      brand: {
        domain: access.brand.domain,
        appName: access.brand.appName,
        signupMode: access.brand.signupMode,
      },
      role: access.role,
      entries: entries ?? [],
    },
  })
}

export async function PATCH(request: Request) {
  const access = await resolveAccess({ write: true })
  if (!access.ok) return access.response

  const validation = await validateBody(request, BrandSignupModeSchema)
  if (!validation.success) return validation.response

  const service = createServiceClientNoCookies()
  const { error } = await service
    .from('brands')
    .update({ signup_mode: validation.data.signup_mode })
    .eq('id', access.brand.id)

  if (error) {
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Kunde inte spara.', message_en: 'Could not save.' } },
      { status: 500 },
    )
  }

  // The host-resolution cache holds the old mode for up to ~60s; drop it so
  // the gate on this server instance flips immediately. Other instances
  // converge within the TTL, same as every other brand edit.
  clearBrandCache()

  return NextResponse.json({ data: { signupMode: validation.data.signup_mode } })
}

export async function POST(request: Request) {
  const access = await resolveAccess({ write: true })
  if (!access.ok) return access.response

  const validation = await validateBody(request, BrandAllowlistAddSchema)
  if (!validation.success) return validation.response

  const { data: entry, error } = await access.supabase
    .from('brand_signup_allowlist')
    .insert({
      brand_id: access.brand.id,
      email: validation.data.email,
      note: validation.data.note ?? null,
      created_by: access.userId,
    })
    .select('id, email, note, created_at')
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        {
          error: {
            code: 'CONFLICT',
            message: 'E-postadressen finns redan i listan.',
            message_en: 'That email is already on the list.',
          },
        },
        { status: 409 },
      )
    }
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Kunde inte lägga till.', message_en: 'Could not add the email.' } },
      { status: 500 },
    )
  }

  return NextResponse.json({ data: entry })
}

export async function DELETE(request: Request) {
  const access = await resolveAccess({ write: true })
  if (!access.ok) return access.response

  const validation = await validateBody(request, BrandAllowlistRemoveSchema)
  if (!validation.success) return validation.response

  const { error } = await access.supabase
    .from('brand_signup_allowlist')
    .delete()
    .eq('id', validation.data.id)
    .eq('brand_id', access.brand.id)

  if (error) {
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: 'Kunde inte ta bort.', message_en: 'Could not remove the email.' } },
      { status: 500 },
    )
  }

  return NextResponse.json({ data: { removed: validation.data.id } })
}
