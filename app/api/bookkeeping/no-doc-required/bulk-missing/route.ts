import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { markEntriesNoDocRequired } from '@/lib/bookkeeping/no-doc-required'
import { NEEDS_DOC_SOURCE_TYPES } from '@/lib/worklist/categories'
import { escapeLikePattern } from '@/lib/invoices/duplicate-payment-guard'

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
 * The missing-doc predicate mirrors countVerifikatMissingDocument: posted +
 * NEEDS_DOC source type, no current-version document_attachment, not already
 * exempt.
 */
export const POST = withRouteContext(
  'journal_entry.bulk_missing_no_document_required',
  async (request, { supabase, companyId, user }) => {
    const validation = await validateBody(request, BulkMissingSchema)
    if (!validation.success) return validation.response

    // All formats are enforced by the schema above, so these are already valid
    // (or null). No re-validation needed before they reach the query layer.
    const { period_id, reason, dry_run } = validation.data
    const series = validation.data.series ?? null
    const dateFrom = validation.data.date_from ?? null
    const dateTo = validation.data.date_to ?? null
    const search = validation.data.search?.trim() || null

    // Candidate entries: posted, document-requiring, matching the active filters.
    const candidates = await fetchAllRows<{ id: string }>(({ from, to }) => {
      let q = supabase
        .from('journal_entries')
        .select('id')
        .eq('company_id', companyId)
        .eq('status', 'posted')
        .in('source_type', [...NEEDS_DOC_SOURCE_TYPES])
      if (period_id) q = q.eq('fiscal_period_id', period_id)
      if (series) q = q.eq('voucher_series', series)
      if (dateFrom) q = q.gte('entry_date', dateFrom)
      if (dateTo) q = q.lte('entry_date', dateTo)
      if (search) q = q.ilike('description', `%${escapeLikePattern(search)}%`)
      return q.order('id').range(from, to)
    })

    if (candidates.length === 0) {
      return NextResponse.json({ data: dry_run ? { count: 0 } : { exempted: 0 } })
    }

    // Resolve which candidates already have a document or an exemption by
    // querying ONLY for the candidate ids (chunked), rather than loading the
    // company's full document_attachments + journal_entry_no_doc_required tables
    // into memory. Data minimisation + bounded memory for large migrations.
    const candidateIds = candidates.map((e) => e.id)
    const withDoc = new Set<string>()
    const exempt = new Set<string>()
    const LOOKUP_CHUNK = 300
    for (let i = 0; i < candidateIds.length; i += LOOKUP_CHUNK) {
      const chunk = candidateIds.slice(i, i + LOOKUP_CHUNK)
      const [docRes, exemptRes] = await Promise.all([
        supabase
          .from('document_attachments')
          .select('journal_entry_id')
          .eq('company_id', companyId)
          .eq('is_current_version', true)
          .in('journal_entry_id', chunk),
        supabase
          .from('journal_entry_no_doc_required')
          .select('journal_entry_id')
          .eq('company_id', companyId)
          .in('journal_entry_id', chunk),
      ])
      if (docRes.error) {
        return NextResponse.json({ error: docRes.error.message }, { status: 400 })
      }
      if (exemptRes.error) {
        return NextResponse.json({ error: exemptRes.error.message }, { status: 400 })
      }
      for (const r of (docRes.data ?? []) as { journal_entry_id: string }[]) {
        withDoc.add(r.journal_entry_id)
      }
      for (const r of (exemptRes.data ?? []) as { journal_entry_id: string }[]) {
        exempt.add(r.journal_entry_id)
      }
    }

    const missingIds = candidateIds.filter((id) => !withDoc.has(id) && !exempt.has(id))

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
