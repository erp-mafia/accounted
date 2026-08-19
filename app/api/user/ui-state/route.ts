import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/require-auth'
import type { UserUiState } from '@/types'

// Partial update: the client sends only the keys it changed. Strict schemas
// so typos fail loudly instead of accumulating junk in the jsonb bag.
const BodySchema = z
  .object({
    nav_collapsed: z.boolean().optional(),
    nav_folds: z
      .object({
        register: z.boolean().optional(),
        bokslut: z.boolean().optional(),
      })
      .strict()
      .optional(),
    create_mode: z.record(z.string(), z.string().max(64)).optional(),
    // Assistant panel geometry. Bounds are deliberately looser than the
    // client's viewport clamps: a size saved on a large screen must round-trip
    // even when later read on a small one (the client re-clamps on use).
    agent_panel: z
      .object({
        mode: z.enum(['docked', 'floating']).optional(),
        dock_width: z.number().int().min(320).max(1600).optional(),
        float: z
          .object({
            x: z.number().int().min(-8000).max(16000),
            y: z.number().int().min(-8000).max(16000),
            w: z.number().int().min(280).max(4000),
            h: z.number().int().min(280).max(4000),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    // One-time expired-trial dialog acknowledgement: companyId -> ISO
    // timestamp of the ack. Merged per key like create_mode, so acking one
    // company never clears another's.
    trial_expired_ack: z
      .record(z.string().uuid(), z.string().datetime())
      .optional(),
  })
  .strict()

// User-scoped preference endpoint: no company context exists or is needed,
// so requireAuth() directly (same opt-out as /api/user/locale). RLS scopes
// user_preferences to the caller's own row.
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
    return NextResponse.json({ error: 'Invalid ui_state payload' }, { status: 400 })
  }

  // Read-merge-write: last write wins per key. Fine for cosmetic UI state;
  // concurrent tabs converge on the next read.
  const { data: existing } = await supabase
    .from('user_preferences')
    .select('ui_state')
    .eq('user_id', user.id)
    .maybeSingle()

  const current: UserUiState = (existing?.ui_state as UserUiState) ?? {}
  const patch = parsed.data
  const next: UserUiState = {
    ...current,
    ...patch,
    ...(patch.nav_folds
      ? { nav_folds: { ...current.nav_folds, ...patch.nav_folds } }
      : {}),
    ...(patch.create_mode
      ? { create_mode: { ...current.create_mode, ...patch.create_mode } }
      : {}),
    ...(patch.agent_panel
      ? { agent_panel: { ...current.agent_panel, ...patch.agent_panel } }
      : {}),
    ...(patch.trial_expired_ack
      ? { trial_expired_ack: { ...current.trial_expired_ack, ...patch.trial_expired_ack } }
      : {}),
  }

  const { error: upsertError } = await supabase
    .from('user_preferences')
    .upsert({ user_id: user.id, ui_state: next }, { onConflict: 'user_id' })

  if (upsertError) {
    return NextResponse.json({ error: 'Could not save UI preferences' }, { status: 500 })
  }

  return NextResponse.json({ data: { ui_state: next } })
}
