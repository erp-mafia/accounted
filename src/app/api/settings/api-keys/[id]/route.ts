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
 * means every company the owner belongs to (unrestricted, following future
 * memberships, unless a company stays read-only). An empty array is refused
 * rather than read as unrestricted: only an explicit null widens a key.
 *
 * `read_only_company_ids`: the selected companies where the key may only
 * read (api_key_companies.access = 'read'). null or [] means none. Omitted,
 * the key's current read-only companies that stay selected keep that level:
 * changing which companies a key reaches never lifts a read-only level on
 * its own.
 */
const patchSchema = z
  .object({
    unattended_commit_limit: z.number().positive().max(1_000_000_000).nullable().optional(),
    company_ids: z.array(z.string().uuid()).min(1).max(200).nullable().optional(),
    read_only_company_ids: z.array(z.string().uuid()).max(200).nullable().optional(),
  })
  .refine(
    (body) =>
      body.unattended_commit_limit !== undefined ||
      body.company_ids !== undefined ||
      body.read_only_company_ids !== undefined,
    { message: 'Ange unattended_commit_limit, company_ids eller read_only_company_ids.' },
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
 * and/or its company allowlist and per-company access levels. The company
 * fields are the key owner's to change; anyone else gets 403 owner_required.
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
    const {
      unattended_commit_limit: limit,
      company_ids: requestedCompanyIds,
      read_only_company_ids: requestedReadOnly,
    } = validation.data

    let data: { id: string; unattended_commit_limit?: number | null } | null = null

    // Which companies a key reaches, and what it may do there, is its
    // owner's choice alone. The key lookup below runs on the session client,
    // whose api_keys policies let every member of the company see the key,
    // and the replacement runs as the service role, so without this check any
    // non-viewer member could rewrite a colleague's allowlist: turning a
    // restricted key unrestricted widens it to the owner's other companies,
    // and lifting a read-only level lets it write. Checked before any write,
    // so a request that also sets the limit cannot half apply.
    const editsCompanies = requestedCompanyIds !== undefined || requestedReadOnly !== undefined
    if (editsCompanies) {
      // The key must be this company's and live, same gate as the limit.
      const { data: existing, error: lookupError } = await supabase
        .from('api_keys')
        .select('id, user_id')
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
      if ((existing as { user_id?: string | null }).user_id !== user.id) {
        return errorResponseFromCode('FORBIDDEN', log, {
          requestId,
          details: { field: 'company_ids', reason: 'owner_required' },
        })
      }
    }

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
    let readOnly: string[] | null | undefined
    if (editsCompanies) {
      let memberships
      try {
        memberships = await listUserCompaniesForPicker(supabase, user.id, { activeCompanyId: companyId })
      } catch (err) {
        log.error('company picker list failed', err)
        return errorResponse(err, log, { requestId })
      }

      // Every submitted id is a live membership of the caller (403
      // otherwise), same validation as create. Checked before any
      // service-role read, like everything a caller can cause.
      const memberIds = new Set(memberships.map((company) => company.company_id))
      const foreignSelection = (requestedCompanyIds ?? []).filter((cid) => !memberIds.has(cid))
      const foreign = Array.from(
        new Set([...foreignSelection, ...(requestedReadOnly ?? []).filter((cid) => !memberIds.has(cid))]),
      )
      if (foreign.length > 0) {
        return errorResponseFromCode('FORBIDDEN', log, {
          requestId,
          details: {
            field: foreignSelection.length > 0 ? 'company_ids' : 'read_only_company_ids',
            reason: 'not_a_member',
            company_ids: foreign,
          },
        })
      }
      // The key is listed under, and defaults to, this company: an explicit
      // list that drops it would leave the default outside the set.
      if (requestedCompanyIds && !requestedCompanyIds.includes(companyId)) {
        return errorResponseFromCode('VALIDATION_ERROR', log, {
          requestId,
          details: { field: 'company_ids', reason: 'key_company_required', company_id: companyId },
        })
      }

      // An omitted field keeps what the key has, so only then are its current
      // rows read (service role only, see the GET handler).
      const serviceClient = createServiceClient()
      let rows: Array<{ company_id: string; access: string | null }> = []
      if (requestedCompanyIds === undefined || requestedReadOnly === undefined) {
        const { data: currentRows, error: currentError } = await serviceClient
          .from('api_key_companies')
          .select('company_id, access')
          .eq('api_key_id', id)
        if (currentError) {
          log.error('api_key_companies read failed', currentError)
          return errorResponseFromCode('INTERNAL_ERROR', log, { requestId })
        }
        rows = (currentRows ?? []) as Array<{ company_id: string; access: string | null }>
      }

      // The new state. An omitted company_ids keeps the current set; null
      // means every company. An omitted read_only_company_ids keeps the
      // current read-only companies that stay selected, so narrowing or
      // widening the set never lifts a read-only level by itself.
      const allMemberIds = memberships.map((company) => company.company_id)
      const nextSelection =
        requestedCompanyIds === undefined
          ? rows.length > 0
            ? rows.map((row) => row.company_id)
            : allMemberIds
          : requestedCompanyIds ?? allMemberIds
      const selectionSet = new Set(nextSelection)
      const nextReadOnly =
        requestedReadOnly === undefined
          ? rows.filter((row) => row.access === 'read' && selectionSet.has(row.company_id)).map((row) => row.company_id)
          : requestedReadOnly ?? []
      const notSelected = nextReadOnly.filter((cid) => !selectionSet.has(cid))
      if (notSelected.length > 0) {
        return errorResponseFromCode('VALIDATION_ERROR', log, {
          requestId,
          details: { field: 'read_only_company_ids', reason: 'not_selected', company_ids: notSelected },
        })
      }

      const selection = resolveCompanySelection(nextSelection, memberships, companyId, nextReadOnly)
      if (!selection) {
        // Only reachable when every company the key kept is one the user has
        // since left: refusing beats reading "nothing left" as "everything".
        return errorResponseFromCode('VALIDATION_ERROR', log, {
          requestId,
          details: { field: 'company_ids', reason: 'no_company' },
        })
      }
      allowlist = selection.companyIds
      readOnly = selection.readOnlyCompanyIds
      // Backstop for a kept set (company_ids omitted): the key's own company
      // must stay inside it, like the explicit check above.
      if (allowlist && !allowlist.includes(companyId)) {
        return errorResponseFromCode('VALIDATION_ERROR', log, {
          requestId,
          details: { field: 'company_ids', reason: 'key_company_required', company_id: companyId },
        })
      }

      // Replace the set and its levels as one transaction in a SECURITY
      // DEFINER RPC (migrations 20260928112722 and 20260928112724): rows
      // outside the new list are deleted, missing ones inserted and every
      // level set together, so a failure never leaves the key at the union
      // of the old and new sets or with a level half applied. null clears
      // every row (unrestricted); the explicit read-only list (an empty one
      // when there are none) is what lets the RPC lift a level at all. The
      // RPC re-checks membership, the level rules and that the key is live;
      // a refusal is a 500 here because the checks above already answered
      // 400 / 403 / 404 for anything a caller can cause.
      const { error: replaceError } = await serviceClient.rpc('replace_api_key_allowlist', {
        p_api_key_id: id,
        p_company_ids: allowlist,
        p_read_only_company_ids: readOnly ?? [],
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
        ...(readOnly !== undefined ? { read_only_company_ids: readOnly } : {}),
      },
    })
  },
  { requireWrite: true },
)
