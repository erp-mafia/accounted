import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/require-auth'
import { createServiceClient } from '@/lib/supabase/server'
import { createLogger } from '@/lib/logger'

const log = createLogger('user/profile')

// User-scoped (not company-scoped): same shape as /api/user/locale, so it
// opts out of withRouteContext and calls requireAuth() directly (MFA still
// enforced on hosted).
const BodySchema = z.object({
  full_name: z.string().min(1).max(100),
})

export async function POST(request: Request) {
  const { user, supabase, error } = await requireAuth()
  if (error) return error

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid name' }, { status: 400 })
  }

  const fullName = parsed.data.full_name.trim()
  if (!fullName) {
    return NextResponse.json({ error: 'Invalid name' }, { status: 400 })
  }

  // Source of truth: profiles.full_name. Read by the account menu
  // (app/(dashboard)/layout.tsx), the first-name greetings, the agent context,
  // and the AGI/KU contact-person field. RLS scopes the update to the caller's
  // own row (profiles_update policy: auth.uid() = id).
  const { error: updateError } = await supabase
    .from('profiles')
    .update({ full_name: fullName })
    .eq('id', user.id)

  if (updateError) {
    return NextResponse.json({ error: 'Could not save name' }, { status: 500 })
  }

  // Best-effort: keep auth user_metadata.full_name in sync so the two stores
  // don't drift. It seeds profiles via the handle_new_user trigger at signup
  // and is wiped on account deletion as a display-name store. updateUserById
  // REPLACES user_metadata wholesale, so read-merge-write to keep other keys.
  try {
    const admin = createServiceClient()
    const { data: current } = await admin.auth.admin.getUserById(user.id)
    const priorMeta = current?.user?.user_metadata ?? {}
    await admin.auth.admin.updateUserById(user.id, {
      user_metadata: { ...priorMeta, full_name: fullName },
    })
  } catch (syncError) {
    log.warn('user_metadata full_name sync failed (non-blocking)', syncError)
  }

  return NextResponse.json({ data: { full_name: fullName } })
}
