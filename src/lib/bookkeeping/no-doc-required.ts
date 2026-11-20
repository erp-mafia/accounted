import type { SupabaseClient } from '@supabase/supabase-js'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { NEEDS_DOC_SOURCE_TYPES } from '@/lib/worklist/types'
import { getErrorMessage } from '@/lib/errors/get-error-message'

const CHUNK_SIZE = 500

/**
 * Bulk-mark posted journal entries as "Inget underlag krävs" (no supporting
 * document required) by inserting rows into journal_entry_no_doc_required.
 *
 * The flag lives in a sidecar table so the verifikation itself stays immutable
 * per BFL: same write the single-entry route performs, just batched. Inserts
 * are chunked (Postgres/PostgREST payload safety) and idempotent: rows that
 * already exist are left untouched (`ignoreDuplicates`).
 *
 * The caller is responsible for passing only entry IDs that belong to
 * `companyId` and are eligible (posted, document-requiring source type); RLS on
 * the table is the security backstop. Used by the SIE-import opt-in auto-exempt
 * flow and the batch-mark endpoint.
 *
 * @returns the number of entry IDs processed (deduped), not the number of new rows.
 */
export async function markEntriesNoDocRequired(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  entryIds: string[],
  reason: string | null,
): Promise<number> {
  if (entryIds.length === 0) return 0

  // De-dupe so a chunk can never carry the same id twice (ON CONFLICT target).
  const uniqueIds = Array.from(new Set(entryIds))

  for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + CHUNK_SIZE)
    const rows = chunk.map((journal_entry_id) => ({
      journal_entry_id,
      company_id: companyId,
      user_id: userId,
      reason: reason ?? null,
    }))

    const { error } = await supabase
      .from('journal_entry_no_doc_required')
      .upsert(rows, { onConflict: 'journal_entry_id', ignoreDuplicates: true })

    if (error) throw new Error(error.message)
  }

  return uniqueIds.length
}

// ---------------------------------------------------------------------------
// "Inget underlag krävs" as an operation (dashboard routes, v1, MCP)
// ---------------------------------------------------------------------------
//
// BFL 5 kap 6 § requires a verifikation for every affärshändelse, and where
// no external underlag exists the verifikation itself (an egen handling:
// avskrivning, periodisering, löneberäkning) is the documentation. The flag
// below says exactly that about one verifikat: it removes the entry from the
// "saknade underlag" worklist. It writes the sidecar table only, never the
// verifikat (which stays immutable), and the audit_log trigger records who
// set or cleared it. Shared by POST/DELETE
// /api/bookkeeping/journal-entries/[id]/no-document-required, POST
// /api/bookkeeping/no-doc-required/batch and lib/operations/journal-entries.ts.


/** Max ids per batch call (the dashboard's selection limit). */
export const NO_DOC_BATCH_MAX = 500

export interface NoDocRequiredResult {
  journal_entry_id: string
  exempted: boolean
  reason: string | null
}

export async function setNoDocumentRequired(
  ctx: OperationContext,
  entryId: string,
  reason: string | null,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<NoDocRequiredResult>> {
  const { data: entry, error: entryError } = await ctx.supabase
    .from('journal_entries')
    .select('id, status, voucher_series, voucher_number, source_type')
    .eq('id', entryId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (entryError) {
    return { ok: false, code: 'NO_DOC_REQUIRED_FAILED', messageSv: getErrorMessage(entryError) }
  }
  if (!entry) return { ok: false, code: 'JOURNAL_ENTRY_NOT_FOUND' }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        journal_entry_id: entry.id,
        voucher_series: entry.voucher_series ?? null,
        voucher_number: entry.voucher_number ?? null,
        status: entry.status,
        reason,
        will: 'mark the verifikat "Inget underlag krävs" (it leaves the missing-underlag worklist); the verifikat itself is not changed',
      },
    }
  }

  const { error } = await ctx.supabase
    .from('journal_entry_no_doc_required')
    .upsert(
      { journal_entry_id: entryId, company_id: ctx.companyId, user_id: ctx.userId, reason },
      { onConflict: 'journal_entry_id' },
    )
  if (error) return { ok: false, code: 'NO_DOC_REQUIRED_FAILED', messageSv: getErrorMessage(error) }
  return { ok: true, data: { journal_entry_id: entryId, exempted: true, reason } }
}

export async function clearNoDocumentRequired(
  ctx: OperationContext,
  entryId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ journal_entry_id: string; exempted: false; removed: boolean }>> {
  if (options.dryRun) {
    const { data, error } = await ctx.supabase
      .from('journal_entry_no_doc_required')
      .select('journal_entry_id')
      .eq('journal_entry_id', entryId)
      .eq('company_id', ctx.companyId)
      .maybeSingle()
    if (error) return { ok: false, code: 'NO_DOC_REQUIRED_FAILED', messageSv: getErrorMessage(error) }
    return { ok: true, dryRun: true, preview: { journal_entry_id: entryId, currently_exempt: Boolean(data) } }
  }

  // Authorization is company-scoped, not user-scoped: any non-viewer member
  // may revoke any exemption in the company (a shared bookkeeping artefact,
  // reviewed as a team); the audit_log trigger captures the actor. Clearing a
  // flag that is not set succeeds (idempotent) with removed=false.
  const { data, error } = await ctx.supabase
    .from('journal_entry_no_doc_required')
    .delete()
    .eq('journal_entry_id', entryId)
    .eq('company_id', ctx.companyId)
    .select('journal_entry_id')
  if (error) return { ok: false, code: 'NO_DOC_REQUIRED_FAILED', messageSv: getErrorMessage(error) }
  return {
    ok: true,
    data: { journal_entry_id: entryId, exempted: false, removed: Array.isArray(data) && data.length > 0 },
  }
}

export interface BatchNoDocRequiredResult {
  exempted: number
  journal_entry_ids: string[]
  skipped_ids: string[]
}

/**
 * Mark many verifikat. Only POSTED entries of this company whose source type
 * requires an underlag are marked; every other id (unknown, other company,
 * draft, reversed, an entry type that never needs one) is skipped and
 * reported, never an error, so one stale id cannot fail a selection.
 */
export async function batchSetNoDocumentRequired(
  ctx: OperationContext,
  entryIds: string[],
  reason: string | null,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<BatchNoDocRequiredResult>> {
  const requested = Array.from(new Set(entryIds))
  const ownedIds: string[] = []
  // Validate ownership in chunks so the PostgREST in() URL stays bounded.
  for (let i = 0; i < requested.length; i += 200) {
    const chunk = requested.slice(i, i + 200)
    const { data, error } = await ctx.supabase
      .from('journal_entries')
      .select('id')
      .eq('company_id', ctx.companyId)
      .eq('status', 'posted')
      .in('source_type', [...NEEDS_DOC_SOURCE_TYPES])
      .in('id', chunk)
    if (error) return { ok: false, code: 'NO_DOC_REQUIRED_FAILED', messageSv: getErrorMessage(error) }
    ownedIds.push(...(data ?? []).map((r) => r.id as string))
  }
  const owned = new Set(ownedIds)
  const skipped = requested.filter((id) => !owned.has(id))

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        would_exempt: ownedIds.length,
        journal_entry_ids: ownedIds,
        skipped_ids: skipped,
        reason,
        will: 'mark the listed posted verifikat "Inget underlag krävs"; the verifikat themselves are not changed',
      },
    }
  }

  if (ownedIds.length === 0) return { ok: true, data: { exempted: 0, journal_entry_ids: [], skipped_ids: skipped } }
  try {
    const exempted = await markEntriesNoDocRequired(ctx.supabase, ctx.companyId, ctx.userId, ownedIds, reason)
    return { ok: true, data: { exempted, journal_entry_ids: ownedIds, skipped_ids: skipped } }
  } catch (err) {
    return { ok: false, code: 'NO_DOC_REQUIRED_FAILED', messageSv: getErrorMessage(err) }
  }
}
