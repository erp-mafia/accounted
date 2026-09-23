import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * Approval authority in SEK: the largest amount this key may commit with no
 * human in the loop. null clears the ceiling (unlimited, the default).
 *
 * Bounded at 1 000 000 000 so a typo cannot store a number the numeric(14,2)
 * column would reject at insert time with a raw Postgres error. The DB CHECK
 * (> 0) is the real guarantee; this is the friendly message in front of it.
 */
const patchSchema = z.object({
  unattended_commit_limit: z.number().positive().max(1_000_000_000).nullable(),
})

/**
 * DELETE /api/settings/api-keys/[id]: Revoke an API key (soft delete)
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'api_key.revoke',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId } = ctx

    const { error } = await supabase
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
      .eq('company_id', companyId)
      .is('revoked_at', null)

    if (error) {
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)

/**
 * PATCH /api/settings/api-keys/[id]: set the key's unattended commit limit.
 *
 * Deliberately narrow: name and scopes are NOT editable here. Silently
 * widening a key's scopes after the fact would defeat the point of showing the
 * scope list at creation, and the separation-of-duties check
 * (findStageApproveConflict) runs only on POST.
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'api_key.update',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId } = ctx

    const validation = await validateBody(request, patchSchema)
    if (!validation.success) return validation.response

    // Revoked keys are deliberately excluded: raising a limit on a key that no
    // longer authenticates reads as re-enabling it, and it does not.
    const { data, error } = await supabase
      .from('api_keys')
      .update({ unattended_commit_limit: validation.data.unattended_commit_limit })
      .eq('id', id)
      .eq('company_id', companyId)
      .is('revoked_at', null)
      .select('id, unattended_commit_limit')
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ error: 'API-nyckeln hittades inte.' }, { status: 404 })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
