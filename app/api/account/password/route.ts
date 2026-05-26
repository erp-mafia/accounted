import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { createLogger } from '@/lib/logger'

const log = createLogger('api/account/password')

const SetPasswordSchema = z.object({
  password: z
    .string()
    .min(8, 'Lösenordet måste vara minst 8 tecken')
    .refine(
      (v) =>
        /[a-z]/.test(v) &&
        /[A-Z]/.test(v) &&
        /[0-9]/.test(v) &&
        /[^a-zA-Z0-9]/.test(v),
      'Lösenordet måste innehålla versaler, gemener, siffror och specialtecken',
    ),
})

/**
 * POST /api/account/password
 *
 * Server-routed password set/change. Wraps `supabase.auth.updateUser({ password })`
 * on the user's own session, then flips `app_metadata.has_password = true` via the
 * service client (clients can't write app_metadata).
 *
 * This route is the single write path for setting a password. SecuritySettings,
 * the reset-password page, and the new /account/set-password page all funnel
 * through here so the flag stays in sync — see lib/auth/has-password.ts.
 *
 * If the password update succeeds but the flag write fails, we log and still
 * return success: the user has a working password and the banner will show one
 * more time, but a retry will re-flip the flag.
 */
export async function POST(request: Request) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await validateBody(request, SetPasswordSchema)
  if (!result.success) return result.response
  const { password } = result.data

  const { error: updateError } = await supabase.auth.updateUser({ password })
  if (updateError) {
    log.warn('updateUser({password}) failed', {
      userId: user.id,
      code: (updateError as { code?: string }).code,
      status: updateError.status,
    })
    return NextResponse.json(
      {
        error:
          updateError.message ||
          'Kunde inte uppdatera lösenord. Försök igen.',
      },
      { status: 400 },
    )
  }

  // Read-merge-write so we don't wipe sibling app_metadata keys.
  // updateUserById replaces app_metadata wholesale (see lib/auth/has-password.ts
  // and the comment in app/api/account/delete/route.ts).
  const service = createServiceClient()
  let flagWriteOk = false
  try {
    const { data: u } = await service.auth.admin.getUserById(user.id)
    const prior = u?.user?.app_metadata ?? {}
    await service.auth.admin.updateUserById(user.id, {
      app_metadata: { ...prior, has_password: true },
    })
    flagWriteOk = true
  } catch (err) {
    log.error('failed to flip has_password flag after successful password set', {
      userId: user.id,
      err,
    })
    // Don't surface the failure: the user has a working password. The
    // banner will show once more and a retry will succeed.
  }

  log.info('password set', { userId: user.id, flagWriteOk })

  return NextResponse.json({ data: { ok: true } })
}
