import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { saveMappings } from '@/lib/import/sie-import'
import type { AccountMapping } from '@/lib/import/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

// Mirrors what saveMappings() (lib/import/sie-import.ts) reads off each
// element: sourceAccount/sourceName/targetAccount/confidence/matchType land
// verbatim in sie_account_mappings columns. Everything except sourceAccount is
// optional because saveMappings itself tolerates absence: it filters out
// elements with a falsy targetAccount (unmapped accounts travel in the same
// array), and confidence/match_type fall back to their column defaults.
// The point of the schema is type safety: a wrongly-typed element used to
// reach Postgres and surface as a 500 instead of a 400.
const SieMappingElementSchema = z.object({
  sourceAccount: z.string().min(1).max(20),
  sourceName: z.string().max(200).nullish(),
  targetAccount: z.string().max(20).nullish(),
  targetName: z.string().max(200).nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  matchType: z.enum(['exact', 'name', 'class', 'manual', 'bas_range']).nullish(),
  isOverride: z.boolean().nullish(),
})

const SaveMappingsSchema = z.object({
  mappings: z.array(SieMappingElementSchema),
})

const UpdateMappingSchema = z.object({
  sourceAccount: z.string().min(1).max(20),
  targetAccount: z.string().min(1).max(20),
  sourceName: z.string().max(200).nullish(),
})

/**
 * GET /api/import/sie/mappings
 * Get all saved account mappings for the user
 */
export const GET = withRouteContext(
  'sie_import.mappings.list',
  async (_request, { supabase, companyId }) => {
    const { data, error } = await supabase
      .from('sie_account_mappings')
      .select('*')
      .eq('company_id', companyId)
      .order('source_account')

    if (error) {
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }

    return NextResponse.json({ data })
  },
)

/**
 * POST /api/import/sie/mappings
 * Save account mappings (bulk upsert)
 */
export const POST = withRouteContext(
  'sie_import.mappings.save',
  async (request, { supabase, companyId, user }) => {
    const validation = await validateBody(request, SaveMappingsSchema)
    if (!validation.success) return validation.response
    // Sparse elements are deliberate (see the schema comment): saveMappings
    // handles absent fields itself, so the wire type is a relaxed superset of
    // AccountMapping.
    const mappings = validation.data.mappings as unknown as AccountMapping[]

    try {
      // saveMappings' second parameter is the tenant key: it lands verbatim in
      // sie_account_mappings.company_id, which is NOT NULL and FK-bound to
      // companies. This used to pass user.id, so every row the endpoint tried
      // to write carried a user UUID in the company column. companyId is
      // resolved by withRouteContext from the caller's own membership and is
      // never taken from the request body, so a caller cannot write mappings
      // into a company they do not belong to.
      // userId is passed explicitly: sie_account_mappings.user_id is NOT NULL
      // with no default, and saveMappings' session fallback returns nothing on
      // the cookieless service client used by API-key and MCP callers.
      await saveMappings(supabase, companyId, mappings, user.id)
      return NextResponse.json({ success: true })
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? getUserErrorMessage(error) : 'Failed to save mappings' },
        { status: 500 }
      )
    }
  },
  { requireWrite: true },
)

/**
 * PUT /api/import/sie/mappings
 * Update a single mapping
 */
export const PUT = withRouteContext(
  'sie_import.mappings.update',
  async (request, { supabase, user, companyId }) => {
    const validation = await validateBody(request, UpdateMappingSchema)
    if (!validation.success) return validation.response
    const { sourceAccount, targetAccount, sourceName } = validation.data

    // source_name is the label the exporting system gave the account in the SIE
    // file's #KONTO record ('#KONTO 1910 "Kassa"'). During the mapping review it
    // is the only thing that tells one unfamiliar source account number from
    // another, and lib/import/account-mapper.ts reads it back for display. It is
    // per-file and cannot be recomputed from the BAS chart, so read the stored
    // value and carry it forward instead of requiring the caller to resend it: a
    // client that doesn't know about the field is exactly how it got erased.
    const { data: existing, error: existingError } = await supabase
      .from('sie_account_mappings')
      .select('source_name')
      .eq('company_id', companyId)
      .eq('source_account', sourceAccount)
      .maybeSingle()

    if (existingError) {
      return NextResponse.json({ error: getUserErrorMessage(existingError) }, { status: 500 })
    }

    // A caller that does know the label (the import review sends it straight
    // from the parsed file) wins, so the first save can set it; otherwise keep
    // whatever is already stored.
    const resolvedSourceName =
      typeof sourceName === 'string' && sourceName.trim().length > 0
        ? sourceName
        : (existing?.source_name ?? null)

    const { data, error } = await supabase
      .from('sie_account_mappings')
      .upsert({
        user_id: user.id,
        company_id: companyId,
        source_account: sourceAccount,
        source_name: resolvedSourceName,
        target_account: targetAccount,
        confidence: 1.0,
        match_type: 'manual',
      }, {
        // The (user_id, source_account) unique constraint was dropped by the
        // multi-tenant refactor; (company_id, source_account) is the one that
        // exists, and the one saveMappings() upserts against.
        onConflict: 'company_id,source_account',
      })
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)

/**
 * DELETE /api/import/sie/mappings
 * Delete a specific mapping or all mappings
 */
export const DELETE = withRouteContext(
  'sie_import.mappings.delete',
  async (request, { supabase, companyId }) => {
    const { searchParams } = new URL(request.url)
    const sourceAccount = searchParams.get('sourceAccount')

    if (sourceAccount) {
      // Delete specific mapping
      const { error } = await supabase
        .from('sie_account_mappings')
        .delete()
        .eq('company_id', companyId)
        .eq('source_account', sourceAccount)

      if (error) {
        return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
      }
    } else {
      // Delete all mappings
      const { error } = await supabase
        .from('sie_account_mappings')
        .delete()
        .eq('company_id', companyId)

      if (error) {
        return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
      }
    }

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
