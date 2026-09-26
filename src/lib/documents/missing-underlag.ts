import type { SupabaseClient } from '@supabase/supabase-js'
import { nextDay } from '@/lib/core/bookkeeping/kontantmetod-cutoff'

/**
 * Gross floor for the missing-underlag blocker. ML 17 kap 26-28 § (förenklad
 * faktura) expresses 4 000 kr inclusive of moms, so the comparison is against
 * the gross (sum of debits, equal to sum of credits in a balanced entry). For
 * EU acquisitions and domestic reverse-charge buyer entries the calculated VAT
 * lines inflate that sum, which can pull a sub-threshold purchase above 4 000:
 * a false positive in favour of asking for the underlag, the safe direction.
 */
export const MISSING_UNDERLAG_MIN_GROSS_SEK = 4000

/** One `verifikat_without_documents` page-of-one, used only for its total. */
async function totalMissingUnderlagSince(
  supabase: SupabaseClient,
  companyId: string,
  since: string
): Promise<number> {
  const { data, error } = await supabase.rpc('verifikat_without_documents', {
    p_company_id: companyId,
    p_since: since,
    p_min_amount: MISSING_UNDERLAG_MIN_GROSS_SEK,
    // p_limit only sizes the page; total_count is computed over the FULL
    // filtered set in an independent CTE, so 1 is the cheapest valid size.
    p_limit: 1,
    p_offset: 0,
  })
  if (error) throw new Error(`verifikat_without_documents failed: ${error.message}`)
  const result = data as { ok?: boolean; code?: string; total_count?: number } | null
  if (!result?.ok) {
    throw new Error(`verifikat_without_documents failed: ${result?.code ?? 'unknown error'}`)
  }
  return result.total_count ?? 0
}

/**
 * Posted verifikat dated within [start, end] that genuinely lack an underlag
 * and whose gross reaches MISSING_UNDERLAG_MIN_GROSS_SEK.
 *
 * BFL 5 kap 6-7 §: every affärshändelse needs a verifikation, and the
 * verifikation must reference its underlag. This delegates to the
 * `verifikat_without_documents` RPC, the SINGLE owner of that predicate: the
 * same SQL behind the web worklist badge (countVerifikatMissingDocument) and
 * behind gnubok_list_verifikat_without_documents. It carries three things a
 * hand-rolled scan here kept getting wrong:
 *
 *   1. the needs-doc source types (mirrors NEEDS_DOC_SOURCE_TYPES,
 *      lib/worklist/categories.ts, pinned by
 *      tests/pg/document-surfaces-unification.pg.test.ts). The local list read
 *      'supplier_invoice' and 'receipt', which are not members of the
 *      journal_entries.source_type CHECK at all: PostgREST matched zero rows,
 *      so supplier-invoice verifikat NEVER surfaced here and the momsperiod
 *      got a clean bill of health on exactly the entry types most likely to be
 *      missing their underlag;
 *   2. is_current_version, so a superseded document version does not silence
 *      the warning, and journal_entry_no_doc_required, so an explicit user
 *      waiver does;
 *   3. BFL 5 kap 7 § hänvisning till underlag: a payment verifikat whose
 *      supplier invoice carries an anchored document is covered by that
 *      document even though the doc row hangs on the registration verifikat.
 *      Without this, adding supplier_invoice_paid to the list would flag every
 *      paid supplier invoice in the period (the 2026-07-24 support case).
 *
 * The RPC takes `since` and no upper bound, so the in-period count is the
 * difference between two filter-respecting totals. Both calls run the same
 * predicate, so the subtraction is exact rather than an estimate.
 */
export async function countMissingUnderlagInPeriod(
  supabase: SupabaseClient,
  companyId: string,
  start: string,
  end: string
): Promise<number> {
  const [fromStart, afterEnd] = await Promise.all([
    totalMissingUnderlagSince(supabase, companyId, start),
    totalMissingUnderlagSince(supabase, companyId, nextDay(end)),
  ])
  return Math.max(0, fromStart - afterEnd)
}
