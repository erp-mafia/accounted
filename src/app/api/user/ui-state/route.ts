import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/require-auth'
import type { UserUiState } from '@/types'
import { SKIPPABLE_SETUP_STEPS } from '@/lib/onboarding/checklist'
import { NAV_FAVORITES_CAP } from '@/lib/navigation/favorites'

// Partial update: the client sends only the keys it changed. Strict schemas
// so typos fail loudly instead of accumulating junk in the jsonb bag.
const BodySchema = z
  .object({
    // Retired with the Standard layout: the layout picker wrote `shell`, the
    // old sidebar's collapse rail and folds wrote `nav_collapsed` and
    // `nav_folds`. Still accepted in their old shapes so a tab opened before
    // the removal never gets a 400, and dropped before the merge below, so
    // nothing new is stored.
    shell: z.enum(['v1', 'v2']).optional(),
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
    // Kom igång steps skipped, per company: companyId -> step ids. Merged
    // per key like trial_expired_ack; the list per company is replaced
    // whole (skipping or un-skipping sends that company's full list).
    setup_skipped: z
      .record(z.string().uuid(), z.array(z.enum(SKIPPABLE_SETUP_STEPS)).max(SKIPPABLE_SETUP_STEPS.length))
      .optional(),
    // Hem's first-thing block closed, per company: companyId -> ISO
    // timestamp of the close. Merged per key like trial_expired_ack.
    first_thing_closed: z
      .record(z.string().uuid(), z.string().datetime())
      .optional(),
    // One-time Discord invite card: when it was closed or used. Plain
    // top-level value, so the default spread below replaces it.
    discord_invite_dismissed_at: z.string().datetime().optional(),
    // The floating support button hidden or shown again (lib/ui-state/
    // fab-preference.ts). Plain top-level value, replaced by the spread.
    support_fab_hidden: z.boolean().optional(),
    // Transaktioner column visibility. Replaced whole, never merged:
    // the list IS the preference.
    tx_columns: z
      .object({ hidden: z.array(z.string().max(32)).max(16).optional() })
      .strict()
      .optional(),
    // Favoriter (lib/navigation/favorites.ts): the hrefs of the menu rows the
    // person pinned, in the order they were added. Replaced whole, never
    // merged: the list IS the preference. An entry is a route path; the
    // sidebar draws one only when it is a row of the menu, so nothing stored
    // here is ever followed as a link.
    nav_favorites: z.array(z.string().max(200).startsWith('/')).max(NAV_FAVORITES_CAP).optional(),
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
  // The retired keys are validated above and never written.
  const { shell: _shell, nav_collapsed: _navCollapsed, nav_folds: _navFolds, ...patch } = parsed.data
  const next: UserUiState = {
    ...current,
    ...patch,
    ...(patch.create_mode
      ? { create_mode: { ...current.create_mode, ...patch.create_mode } }
      : {}),
    ...(patch.agent_panel
      ? { agent_panel: { ...current.agent_panel, ...patch.agent_panel } }
      : {}),
    ...(patch.trial_expired_ack
      ? { trial_expired_ack: { ...current.trial_expired_ack, ...patch.trial_expired_ack } }
      : {}),
    ...(patch.first_thing_closed
      ? { first_thing_closed: { ...current.first_thing_closed, ...patch.first_thing_closed } }
      : {}),
    ...(patch.setup_skipped
      ? { setup_skipped: { ...current.setup_skipped, ...patch.setup_skipped } }
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
