import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { NEEDS_DOC_SOURCE_TYPES } from '@/lib/worklist/categories'
import { escapeLikePattern } from '@/lib/invoices/duplicate-payment-guard'
import { parseVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

/**
 * Shared resolution of "posted verifikat that lack underlag", scoped by the
 * journal list's filters. Single TS mirror of the verifikat_without_documents
 * RPC predicate (posted + document-requiring source type, no current-version
 * document, no BFL 5 kap 7 § hänvisning via a supplier invoice whose retained
 * document is anchored to a journal entry, no journal_entry_no_doc_required
 * exemption). Used by the bulk "Inget underlag krävs" route and the journal
 * list's missing_underlag filter so the two can never disagree.
 */

export interface MissingUnderlagFilters {
  periodId?: string | null
  /** Single uppercase verifikationsserie (A-Z); null/undefined = all. */
  series?: string | null
  dateFrom?: string | null
  dateTo?: string | null
  /** Free-text ilike over the voucher description. */
  search?: string | null
}

/**
 * The candidate columns carried through resolution: enough for the caller to
 * sort the full missing set without a second round-trip. total_amount is the
 * computed column from migration 20260811100000 (sum of debit lines).
 */
export interface MissingUnderlagEntry {
  id: string
  /** Sort columns; absent when the caller asked for ids only. */
  entry_date?: string
  voucher_series?: string | null
  voucher_number?: number | null
  description?: string | null
  total_amount?: number | null
}

/**
 * Sub-query failure. `userMessage` is already mapped through getErrorMessage()
 * (user-facing Swedish), never a raw driver message.
 */
export class MissingUnderlagQueryError extends Error {
  constructor(public readonly userMessage: string) {
    super(userMessage)
  }
}

// Journal-entry ids are interpolated into the supplier-invoice .or() filter
// string below, so they must be UUIDs. They originate from journal_entries.id
// (DB-sourced, never request input), but this guard keeps the injection-safety
// contract identical to /api/documents/counts.
const uuidSchema = z.string().uuid()

// 150 keeps the embedded id lists well under PostgREST's URL-length limit:
// the supplier-invoice .or() below repeats the chunk twice (registration +
// payment FK), so a larger chunk would risk truncating the GET filter.
const LOOKUP_CHUNK = 150

/**
 * Resolve every posted, document-requiring journal entry matching the filters
 * that currently has neither an underlag nor an exemption. Returns the full
 * missing set (bounded by the tenant's ledger size), ordered by id for
 * stability; callers sort/page as needed.
 *
 * `idOnly` skips the sort columns, notably total_amount, a computed column
 * evaluated per candidate row. The bulk-exempt route (built for post-import
 * floods of thousands of entries) doesn't sort, so it must not pay that
 * per-row aggregate on its full candidate scan.
 *
 * @throws MissingUnderlagQueryError when a sub-query fails.
 */
export async function resolveMissingUnderlagEntries(
  supabase: SupabaseClient,
  companyId: string,
  filters: MissingUnderlagFilters = {},
  { idOnly = false }: { idOnly?: boolean } = {},
): Promise<MissingUnderlagEntry[]> {
  const periodId = filters.periodId ?? null
  const series = filters.series ?? null
  const dateFrom = filters.dateFrom ?? null
  const dateTo = filters.dateTo ?? null
  const search = filters.search?.trim() || null

  // Candidate entries: posted, document-requiring, matching the active filters.
  const candidates = await fetchAllRows<MissingUnderlagEntry>(({ from, to }) => {
    // The cast keeps supabase-js's type-level select parser on a single
    // literal: a union of two select strings fails its template-literal
    // parsing. Runtime behavior is the actual string; rows are typed by
    // fetchAllRows<MissingUnderlagEntry> either way.
    const selectCols = (idOnly
      ? 'id'
      : 'id, entry_date, voucher_series, voucher_number, description, total_amount') as 'id'
    let q = supabase
      .from('journal_entries')
      .select(selectCols)
      .eq('company_id', companyId)
      .eq('status', 'posted')
      .in('source_type', [...NEEDS_DOC_SOURCE_TYPES])
    if (periodId) q = q.eq('fiscal_period_id', periodId)
    if (series) q = q.eq('voucher_series', series)
    if (dateFrom) q = q.gte('entry_date', dateFrom)
    if (dateTo) q = q.lte('entry_date', dateTo)
    if (search) {
      // Same search semantics as the journal list's direct query: a
      // voucher-label-shaped needle ("A209") also matches series+number, so
      // searching for a voucher by its own label works with the filter on.
      const needle = `%${escapeLikePattern(search)}%`
      const voucher = parseVoucher(search)
      if (voucher) {
        const quotedNeedle = `"${needle.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
        q = q.or(
          `description.ilike.${quotedNeedle},and(voucher_series.eq.${voucher.series},voucher_number.eq.${voucher.number})`,
        )
      } else {
        q = q.ilike('description', needle)
      }
    }
    return q.order('id').range(from, to)
  })

  if (candidates.length === 0) return []

  // Resolve which candidates already have a document or an exemption by
  // querying ONLY for the candidate ids (chunked), rather than loading the
  // company's full document_attachments + journal_entry_no_doc_required tables
  // into memory. Data minimisation + bounded memory for large migrations.
  const candidateIds = candidates.map((e) => e.id)
  const withDoc = new Set<string>()
  const exempt = new Set<string>()
  for (let i = 0; i < candidateIds.length; i += LOOKUP_CHUNK) {
    const chunk = candidateIds.slice(i, i + LOOKUP_CHUNK)
    // Only UUIDs reach the interpolated .or() string (the .in() array filters
    // are already injection-safe); mirrors the guard in documents/counts.
    const chunkInList = `(${chunk.filter((id) => uuidSchema.safeParse(id).success).join(',')})`
    const [docRes, siRefRes, sipRefRes, exemptRes] = await Promise.all([
      supabase
        .from('document_attachments')
        .select('journal_entry_id')
        .eq('company_id', companyId)
        .eq('is_current_version', true)
        .in('journal_entry_id', chunk),
      // BFL 5 kap 7 § hänvisning: an entry referenced by a supplier invoice
      // whose source document is retained AND anchored to a journal entry
      // is NOT missing underlag (only anchored docs sit behind the WORM
      // deletion guards). Mirrors the verifikat_without_documents RPC.
      supabase
        .from('supplier_invoices')
        .select(
          'registration_journal_entry_id, payment_journal_entry_id, document:document_attachments(journal_entry_id)',
        )
        .eq('company_id', companyId)
        .not('document_id', 'is', null)
        .or(
          `registration_journal_entry_id.in.${chunkInList},payment_journal_entry_id.in.${chunkInList}`,
        ),
      supabase
        .from('supplier_invoice_payments')
        .select(
          'journal_entry_id, supplier_invoice:supplier_invoices(document_id, document:document_attachments(journal_entry_id))',
        )
        .eq('company_id', companyId)
        .in('journal_entry_id', chunk),
      supabase
        .from('journal_entry_no_doc_required')
        .select('journal_entry_id')
        .eq('company_id', companyId)
        .in('journal_entry_id', chunk),
    ])
    for (const res of [docRes, siRefRes, sipRefRes, exemptRes]) {
      if (res.error) throw new MissingUnderlagQueryError(getUserErrorMessage(res.error))
    }
    for (const r of (docRes.data ?? []) as { journal_entry_id: string }[]) {
      withDoc.add(r.journal_entry_id)
    }
    for (const r of (siRefRes.data ?? []) as unknown as {
      registration_journal_entry_id: string | null
      payment_journal_entry_id: string | null
      document: { journal_entry_id: string | null } | null
    }[]) {
      if (!r.document?.journal_entry_id) continue // unanchored: not underlag
      if (r.registration_journal_entry_id) withDoc.add(r.registration_journal_entry_id)
      if (r.payment_journal_entry_id) withDoc.add(r.payment_journal_entry_id)
    }
    for (const r of (sipRefRes.data ?? []) as unknown as {
      journal_entry_id: string | null
      supplier_invoice: {
        document_id: string | null
        document: { journal_entry_id: string | null } | null
      } | null
    }[]) {
      if (r.journal_entry_id && r.supplier_invoice?.document?.journal_entry_id) {
        withDoc.add(r.journal_entry_id)
      }
    }
    for (const r of (exemptRes.data ?? []) as { journal_entry_id: string }[]) {
      exempt.add(r.journal_entry_id)
    }
  }

  return candidates.filter((e) => !withDoc.has(e.id) && !exempt.has(e.id))
}
