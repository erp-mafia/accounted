/**
 * Documents in the archive that are attached to nothing.
 *
 * A `document_attachments` row is reachable from eight places: a journal
 * entry (its own `journal_entry_id`), a bank transaction, a receipt, an
 * inbox item, a supplier invoice, an invoice delivery, an inbound Peppol
 * document, an årsredovisning submission, and a ROT/RUT payout request. A
 * row referenced by none of them is stored, retained for seven years under
 * BFL, and connected to no bookkeeping at all. Nothing surfaces those today,
 * so they accumulate silently: 4 497 of them across 210 companies as of
 * 2026-08-27, 481 of them created in the preceding week.
 *
 * ## Why the mime allow-list is the whole design
 *
 * The obvious predicate, "current version with no journal_entry_id and no
 * referencing row", returns 15 806 rows on production. 11 309 of those are
 * `application/json` and every single one is named `psd2-response_<ts>_pN.json`:
 * the archived bank-API responses the PSD2 integration stores as evidence of
 * each fetch. They are SUPPOSED to have no verifikat and no transaction. Put
 * them on an attention surface and an agent is handed 11 309 items of busywork
 * that it must not action, which is worse than showing nothing.
 *
 * Measured on production 2026-08-27: of the unreferenced rows,
 * `application/json` was 11 309 of 11 309 PSD2 archive, and pdf / png / jpeg /
 * heic were 0 of 4 495. The split is clean, so the rule is an allow-list of
 * the mime types an underlag can actually be, not a filename exclusion. A new
 * machine-payload format (XML, CSV, an audit bundle) stays out by default
 * rather than needing another exclusion added after it starts leaking.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Mime types a bookkeeping underlag can plausibly be: something a human could
 * open and read as a receipt or an invoice. Everything else on this surface is
 * a machine payload that is unlinked by design.
 */
export const UNDERLAG_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/heic',
  'image/webp',
  'image/tiff',
] as const

/**
 * The candidate scan is bounded, and the bound is set by URL length rather
 * than by table size.
 *
 * Every candidate id is sent back through eight `.in(column, ids)` lookups,
 * and a UUID costs ~38 bytes in a PostgREST query string, so 300 ids is
 * already a ~12 KB URL per lookup. A cap in the thousands would exceed what
 * the gateway accepts and the eight lookups would start failing, which the
 * error handling below would read as "nothing claims these" and would turn
 * every candidate into a false positive. Small and honest beats large and
 * silently wrong.
 *
 * 300 covers all but one company on production (median 3, worst 1 298 as of
 * 2026-08-27). When the cap is hit, `capped` says so and `count` becomes a
 * floor rather than a total, because the caller renders a number either way
 * and a silently truncated one would read as "nearly done".
 */
export const UNLINKED_DOCUMENT_SCAN_CAP = 300

/**
 * A type alias, not an interface, on purpose: the attention resource assigns
 * these straight into its `samples: Record<string, unknown>[]` field, and an
 * interface has no implicit index signature so that assignment does not
 * type-check. Vitest does not typecheck, so this only ever shows up in
 * `npm run build`.
 */
export type UnlinkedDocument = {
  id: string
  file_name: string
  mime_type: string | null
  file_size_bytes: number | null
  upload_source: string | null
  created_at: string
}

export interface UnlinkedDocumentsResult {
  documents: UnlinkedDocument[]
  count: number
  capped: boolean
}

const COLUMNS = 'id, file_name, mime_type, file_size_bytes, upload_source, created_at'

/**
 * The eight tables that can claim a document, as [table, column] pairs.
 *
 * `journal_entry_id` is deliberately absent: it lives on the document row
 * itself and is already excluded by the column filter below.
 */
const REFERENCING_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ['transactions', 'document_id'],
  ['receipts', 'document_id'],
  ['invoice_inbox_items', 'document_id'],
  ['supplier_invoices', 'document_id'],
  ['invoice_deliveries', 'document_attachment_id'],
  ['peppol_inbound_documents', 'xml_document_id'],
  ['arsredovisning_submissions', 'dokument_id'],
  ['rot_rut_payout_requests', 'file_document_id'],
]

/**
 * Underlag-shaped documents in this company's archive that nothing references.
 *
 * Two passes, the same shape as `fetchPurchasesWithoutUnderlag`: the column
 * filter is the cheap part the database can index, and the eight reference
 * lookups settle it afterwards for the candidates that survived. They run only
 * when there are candidates, so the common case (a company with none) costs
 * exactly one query.
 */
export async function fetchUnlinkedDocuments(
  supabase: SupabaseClient,
  companyId: string,
  options?: { limit?: number },
): Promise<UnlinkedDocumentsResult> {
  const cap = options?.limit ?? UNLINKED_DOCUMENT_SCAN_CAP

  const { data: candidates } = await supabase
    .from('document_attachments')
    .select(COLUMNS)
    .eq('company_id', companyId)
    .is('journal_entry_id', null)
    .not('is_current_version', 'is', false)
    .in('mime_type', UNDERLAG_MIME_TYPES as unknown as string[])
    .order('created_at', { ascending: false })
    .limit(cap)

  const rows = (candidates ?? []) as UnlinkedDocument[]
  if (rows.length === 0) return { documents: [], count: 0, capped: false }

  const ids = rows.map((r) => r.id)
  const referenced = new Set<string>()

  // Fetched once for the whole candidate set rather than per row. A failing
  // lookup is treated as "claims nothing", which can only ever ADD a row to
  // the list; the alternative (dropping the whole category on one bad table)
  // would hide real work because an unrelated feature's table misbehaved.
  await Promise.all(
    REFERENCING_COLUMNS.map(async ([table, column]) => {
      const { data } = await supabase.from(table).select(column).in(column, ids)
      // The column name is resolved at runtime, so the client cannot infer a
      // row type here; `unknown` first because the inferred error union does
      // not overlap the record shape.
      const referencingRows = (data ?? []) as unknown as Array<Record<string, string | null>>
      for (const row of referencingRows) {
        const value = row[column]
        if (value) referenced.add(value)
      }
    }),
  )

  const documents = rows.filter((r) => !referenced.has(r.id))
  return { documents, count: documents.length, capped: rows.length >= cap }
}
