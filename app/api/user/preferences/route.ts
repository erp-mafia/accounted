import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/require-auth'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { sessionTimeoutClearCookieOptions } from '@/lib/auth/session-timeout'
import { SESSION_TIMEOUT_COOKIE } from '@/lib/auth/session-timeout-shared'

// User-level UI preferences (not company-scoped), stored on user_preferences.
// Mirrors the /api/user/locale pattern: requireAuth directly because these
// must work even when the user has no active company.

const BodySchema = z
  .object({
    hide_assistant_fab: z.boolean().optional(),
    auto_logout: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one preference is required',
  })

export async function GET() {
  const { user, supabase, error } = await requireAuth()
  if (error) return error

  const { data } = await supabase
    .from('user_preferences')
    .select('hide_assistant_fab, auto_logout')
    .eq('user_id', user.id)
    .maybeSingle()

  return NextResponse.json({
    data: {
      hide_assistant_fab: data?.hide_assistant_fab ?? false,
      auto_logout: data?.auto_logout ?? false,
    },
  })
}

export async function PATCH(request: Request) {
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
    return NextResponse.json({ error: 'Invalid preferences' }, { status: 400 })
  }

  const { hide_assistant_fab, auto_logout } = parsed.data

  // One literal upsert per accepted field combination: the phantom-column
  // schema guard cannot resolve spread payloads, and a single write keeps a
  // multi-field request atomic.
  let upsertError: unknown = null
  if (hide_assistant_fab !== undefined && auto_logout !== undefined) {
    const { error } = await supabase
      .from('user_preferences')
      .upsert(
        { user_id: user.id, hide_assistant_fab, auto_logout },
        { onConflict: 'user_id' },
      )
    upsertError = error
  } else if (hide_assistant_fab !== undefined) {
    const { error } = await supabase
      .from('user_preferences')
      .upsert({ user_id: user.id, hide_assistant_fab }, { onConflict: 'user_id' })
    upsertError = error
  } else if (auto_logout !== undefined) {
    const { error } = await supabase
      .from('user_preferences')
      .upsert({ user_id: user.id, auto_logout }, { onConflict: 'user_id' })
    upsertError = error
  }

  if (upsertError) {
    return NextResponse.json(
      {
        error: getErrorMessage(upsertError, {
          context: 'settings',
          statusCode: 500,
        }),
      },
      { status: 500 },
    )
  }

  const response = NextResponse.json({ data: parsed.data })

  if (parsed.data.auto_logout !== undefined) {
    // The middleware caches the opt-in inside the signed timeout cookie.
    // Clearing it forces a re-mint on the next request, so the change takes
    // effect immediately instead of at the next login.
    response.cookies.set(
      SESSION_TIMEOUT_COOKIE,
      '',
      sessionTimeoutClearCookieOptions(),
    )
  }

  return response
}
