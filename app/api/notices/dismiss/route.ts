import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { NoticeDismissSchema } from '@/lib/api/schemas'

/**
 * POST /api/notices/dismiss: hide one notice for the calling user + company.
 *
 * Dismissals are per user (a colleague still sees the notice) and per notice
 * id; ids embed a state discriminator (lib/notices/types.ts), so a dismissed
 * notice stays hidden only until the underlying condition changes: a NEW
 * failure mints a new id and surfaces again. Idempotent via upsert.
 *
 * No requireWrite: dismissing a personal notice is a per-user preference,
 * not a company-data mutation, so viewers may dismiss too.
 */
export const POST = withRouteContext('notices.dismiss', async (request, ctx) => {
  const validation = await validateBody(request, NoticeDismissSchema)
  if (!validation.success) return validation.response

  const { supabase, companyId, user } = ctx
  const { error } = await supabase.from('notice_dismissals').upsert(
    {
      company_id: companyId,
      user_id: user.id,
      notice_id: validation.data.notice_id,
      dismissed_at: new Date().toISOString(),
    },
    { onConflict: 'company_id,user_id,notice_id' },
  )
  if (error) {
    throw new Error(`notice dismissal failed: ${error.message}`)
  }
  return NextResponse.json({ data: { dismissed: true } })
})
