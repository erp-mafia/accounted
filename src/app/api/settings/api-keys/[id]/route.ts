import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { createServiceClient } from '@/lib/supabase/server'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { listUserCompaniesForPicker, resolveCompanySelection } from '@/lib/company/company-picker'

/**
 * Two independently optional fields; an empty body is a 400, not "clear
 * everything".
 *
 * `unattended_commit_limit`: approval authority in SEK, the largest amount
 * this key may commit with no human in the loop. null clears the ceiling
 * (unlimited, the default). Bounded at 1 000 000 000 so a typo cannot store
 * a number the numeric(14,2) column would reject at insert time with a raw
 * Postgres error. The DB CHECK (> 0) is the real guarantee; this is the
 * friendly message in front of it.
 *
 * `company_ids`: the per-key company allowlist, replaced as a set. null
 * makes the key unrestricted (every company the owner belongs to, including
 * future memberships). An empty array is refused rather than read as
 * unrestricted: only an explicit null widens a key.
 */
const patchSchema = z
  .object({
    unattended_commit_limit: z.number().positive().max(1_000_000_000).nullable().optional(),
    company_ids: z.array(z.string().uuid()).min(1).max(200).nullable().optional(),
  })
  .refine(
    (body) => body.unattended_commit_limit !== undefined || body.company_ids !== undefined,
    { message: 'Ange unattended_commit_limit eller company_ids.' },
  )

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
 * PATCH /api/settings/api-keys/[id]: set the key's unattended commit limit
 * and/or its company allowlist.
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
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, patchSchema)
    if (!validation.success) return validation.response
    const { unattended_commit_limit: limit, company_ids: requestedCompanyIds } = validation.data

    let data: { id: string; unattended_commit_limit?: number | null } | null = null

    if (limit !== undefined) {
      // Revoked keys are deliberately excluded: raising a limit on a key that no
      // longer authenticates reads as re-enabling it, and it does not.
      const { data: updated, error } = await supabase
        .from('api_keys')
        .update({ unattended_commit_limit: limit })
        .eq('id', id)
        .eq('company_id', companyId)
        .is('revoked_at', null)
        .select('id, unattended_commit_limit')
        .maybeSingle()

      if (error) {
        return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
      }
      if (!updated) {
        return NextResponse.json({ error: 'API-nyckeln hittades inte.' }, { status: 404 })
      }
      data = updated
    }

    let allowlist: string[] | null | undefined
    if (requestedCompanyIds !== undefined) {
      // The key must be this company's and live, same gate as the limit.
      const { data: existing, error: lookupError } = await supabase
        .from('api_keys')
        .select('id')
        .eq('id', id)
        .eq('company_id', companyId)
        .is('revoked_at', null)
        .maybeSingle()
      if (lookupError) {
        return NextResponse.json({ error: getUserErrorMessage(lookupError) }, { status: 500 })
      }
      if (!existing) {
        return NextResponse.json({ error: 'API-nyckeln hittades inte.' }, { status: 404 })
      }

      allowlist = null
      if (requestedCompanyIds && requestedCompanyIds.length > 0) {
        // Same validation as create: every id is a live membership of the
        // caller (403 otherwise), and the full set collapses to unrestricted.
        let memberships
        try {
          memberships = await listUserCompaniesForPicker(supabase, user.id, { activeCompanyId: companyId })
        } catch (err) {
          log.error('company picker list failed', err)
          return errorResponse(err, log, { requestId })
        }
        const memberIds = new Set(memberships.map((company) => company.company_id))
        const foreign = requestedCompanyIds.filter((cid) => !memberIds.has(cid))
        if (foreign.length > 0) {
          return errorResponseFromCode('FORBIDDEN', log, {
            requestId,
            details: { field: 'company_ids', reason: 'not_a_member', company_ids: foreign },
          })
        }
        const selection = resolveCompanySelection(requestedCompanyIds, memberships, companyId)
        allowlist = selection?.companyIds ?? null
        // The key is listed under, and defaults to, this company: an
        // allowlist that drops it would leave the default outside the set.
        if (allowlist && !allowlist.includes(companyId)) {
          return errorResponseFromCode('VALIDATION_ERROR', log, {
            requestId,
            details: { field: 'company_ids', reason: 'key_company_required', company_id: companyId },
          })
        }
      }

      // Replace the set as one transaction in a SECURITY DEFINER RPC
      // (migration 20260923160200): rows outside the new list are deleted
      // and missing ones inserted together, so a failure never leaves the
      // key at the union of the old and new sets. null clears every row
      // (unrestricted). The RPC re-checks that every id is a live membership
      // of the key's user and that the key is live; a refusal is a 500 here
      // because the checks above already answered 403 / 404 for anything a
      // caller can cause.
      const { error: replaceError } = await createServiceClient().rpc('replace_api_key_allowlist', {
        p_api_key_id: id,
        p_company_ids: allowlist,
      })
      if (replaceError) {
        log.error('replace_api_key_allowlist failed', replaceError)
        return errorResponseFromCode('INTERNAL_ERROR', log, { requestId })
      }
    }

    return NextResponse.json({
      data: {
        id,
        ...(data ? { unattended_commit_limit: data.unattended_commit_limit } : {}),
        ...(allowlist !== undefined ? { company_ids: allowlist } : {}),
      },
    })
  },
  { requireWrite: true },
)
