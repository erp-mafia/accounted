import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/require-auth'

// User-level UI preferences (not company-scoped), stored on user_preferences.
// Mirrors the /api/user/locale pattern: requireAuth directly because these
// must work even when the user has no active company.

const BodySchema = z
  .object({
    hide_assistant_fab: z.boolean(),
  })
  .strict()

export async function GET() {
  const { user, supabase, error } = await requireAuth()
  if (error) return error

  const { data } = await supabase
    .from('user_preferences')
    .select('hide_assistant_fab')
    .eq('user_id', user.id)
    .maybeSingle()

  return NextResponse.json({
    data: { hide_assistant_fab: data?.hide_assistant_fab ?? false },
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

  const { error: upsertError } = await supabase
    .from('user_preferences')
    .upsert(
      { user_id: user.id, hide_assistant_fab: parsed.data.hide_assistant_fab },
      { onConflict: 'user_id' }
    )

  if (upsertError) {
    return NextResponse.json({ error: 'Could not save preference' }, { status: 500 })
  }

  return NextResponse.json({ data: parsed.data })
}
