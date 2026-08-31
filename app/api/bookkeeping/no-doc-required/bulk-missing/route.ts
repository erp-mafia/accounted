import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { markEntriesNoDocRequired } from '@/lib/bookkeeping/no-doc-required'
import {
  MissingUnderlagQueryError,
  resolveMissingUnderlagEntries,
} from '@/lib/bookkeeping/missing-underlag'

// A real calendar date in YYYY-MM-DD form. Rejects shaped-but-invalid values
// (e.g. 9999-99-99 or 2026-02-30) that a bare /^\d{4}-\d{2}-\d{2}$/ regex would
// let through and that would otherwise reach the query layer.
const isoDate = z.string().refine(
  (v) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
    const [y, m, d] = v.split('-').map(Number)
    const date = new Date(Date.UTC(y, m - 1, d))
    return (
      date.getUTCFullYear() === y &&
      date.getUTCMonth() + 1 === m &&
      date.getUTCDate() === d
    )
  },
  { message: 'Ogiltigt datum (förväntat YYYY-MM-DD)' },
)

const BulkMissingSchema = z.object({
  period_id: z.string().uuid().nullable().optional(),
  // Single uppercase verifikationsserie (A-Z); the list sends null for "all".
  series: z.string().regex(/^[A-Z]$/).nullable().optional(),
  date_from: isoDate.nullable().optional(),
  date_to: isoDate.nullable().optional(),
  search: z.string().max(200).nullable().optional(),
  reason: z.string().trim().max(200).nullable().optional(),
  // When true, only count the matching verifikat (no writes) so the UI can
  // confirm the scope before the user commits.
  dry_run: z.boolean().optional(),
})

/**
 * Mark every posted, document-requiring verifikat that currently lacks an
 * underlag AND matches the active list filters (period / series / date / search)
 * as "Inget underlag krävs", across all pages, in one action. This is the
 * scalable remedy for the "thousands of saknade underlag after a migration"
 * problem; the per-entry batch route handles selective marking.
 *
 * The missing-doc predicate lives in resolveMissingUnderlagEntries (shared
 * with the journal list's missing_underlag filter) and mirrors
 * countVerifikatMissingDocument: posted + NEEDS_DOC source type, no
 * current-version document_attachment, no anchored supplier-invoice reference,
 * not already exempt.
 */
export const POST = withRouteContext(
  'journal_entry.bulk_missing_no_document_required',
  async (request, { supabase, companyId, user }) => {
    const validation = await validateBody(request, BulkMissingSchema)
    if (!validation.success) return validation.response

    // All formats are enforced by the schema above, so these are already valid
    // (or null). No re-validation needed before they reach the query layer.
    const { period_id, reason, dry_run } = validation.data

    let missing
    try {
      missing = await resolveMissingUnderlagEntries(
        supabase,
        companyId,
        {
          periodId: period_id ?? null,
          series: validation.data.series ?? null,
          dateFrom: validation.data.date_from ?? null,
          dateTo: validation.data.date_to ?? null,
          search: validation.data.search ?? null,
        },
        // No sorting here, so skip the per-row total_amount computed column
        // on what can be a full post-import candidate scan.
        { idOnly: true },
      )
    } catch (err) {
      if (err instanceof MissingUnderlagQueryError) {
        // userMessage is already mapped through getErrorMessage() in the
        // resolver: user-facing Swedish, never a raw driver message.
        return NextResponse.json({ error: err.userMessage }, { status: 400 })
      }
      throw err
    }
    const missingIds = missing.map((e) => e.id)

    if (dry_run) {
      return NextResponse.json({ data: { count: missingIds.length } })
    }

    if (missingIds.length === 0) {
      return NextResponse.json({ data: { exempted: 0 } })
    }

    const exempted = await markEntriesNoDocRequired(
      supabase,
      companyId,
      user.id,
      missingIds,
      reason ?? null,
    )

    return NextResponse.json({ data: { exempted } })
  },
  { requireWrite: true },
)
