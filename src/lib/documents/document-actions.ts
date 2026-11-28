/**
 * What a user can do to the company's document archive (document_attachments)
 * outside the upload and link flows: list it, read one document's metadata,
 * and delete an unlinked one. One implementation behind the dashboard route
 * (DELETE /api/documents/[id]), the v1 operations and any MCP tool
 * (lib/operations/documents.ts), so every door applies the same rule:
 *
 *   - a document linked to a verifikat (journal_entry_id or
 *     journal_entry_line_id set, whatever the entry's status;
 *     canDeleteDocument) is räkenskapsinformation under BFL 7 kap 2 § and is
 *     never deleted; the DB trigger block_document_deletion() is the
 *     backstop, deleteDocument() the application check. Correcting one means
 *     a new version, never a delete.
 *   - a document another registered record holds (a supplier invoice or an
 *     utlägg with it as underlag, a booked inbox item with it as its file or
 *     received Peppol XML, a bank transaction) is refused too, each with its
 *     own code (documentDeleteRefusal, lib/documents/deletion.ts).
 *
 * Reads return metadata, never the file bytes (GET .../download). The page
 * text, the reading, the links and the arrivals come only when asked for
 * (include, lib/documents/read/document-detail.ts).
 *
 * A dry run reads and checks; it writes nothing.
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { decodeDefaultCursor, encodeDefaultCursor } from '@/lib/api/v1/pagination'
import { deleteDocument } from '@/lib/core/documents/document-service'
import { canDeleteDocument, documentDeleteRefusal, inboxItemsLeftEmpty, readDocumentDeletePins } from '@/lib/documents/deletion'
import { UUID_RE } from '@/lib/invariants/uuid'
import { toSameOriginStorageRequest } from '@/lib/core/documents/storage-proxy'
import type { DocumentDetail, DocumentDetailPart, readDocumentDetail } from '@/lib/documents/read/document-detail'
import { EFFECTIVE_TYPE_JOIN, fillTypeFromClassification, whereEffectiveType } from '@/lib/documents/locked-period'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

const NOT_FOUND: Failure = { ok: false, code: 'DOC_NOT_FOUND' }

function failed(error: unknown): Failure {
  return { ok: false, code: 'UNKNOWN_ERROR', error }
}

interface DocumentRow {
  id: string
  file_name: string
  mime_type: string | null
  file_size_bytes: number | null
  sha256_hash: string
  version: number
  is_current_version: boolean
  upload_source: string | null
  journal_entry_id: string | null
  journal_entry_line_id: string | null
  created_at: string
  doc_type: string | null
}

/** The columns of DocumentRow. */
const DOCUMENT_COLUMNS =
  'id, file_name, mime_type, file_size_bytes, sha256_hash, version, is_current_version, upload_source, journal_entry_id, journal_entry_line_id, created_at, doc_type'

interface DocumentDetailRow extends DocumentRow {
  original_id: string | null
  superseded_by_id: string | null
  digitization_date: string | null
  page_count: number | null
  pages_read_at: string | null
  read_error: string | null
  admission_state: string | null
  extracted_data: unknown
  extracted_at: string | null
  extraction_model: string | null
}

export interface DocumentPublic {
  document_id: string
  file_name: string
  mime_type: string | null
  file_size_bytes: number | null
  sha256_hash: string
  version: number
  is_current_version: boolean
  upload_source: string | null
  linked: boolean
  journal_entry_id: string | null
  journal_entry_line_id: string | null
  created_at: string
  /** The type readers show (lib/documents/locked-period.ts); null while it has none. */
  doc_type: string | null
}

export interface DocumentDetailPublic extends DocumentPublic, DocumentDetail {
  original_id: string | null
  superseded_by_id: string | null
  digitization_date: string | null
  transaction_ids: string[]
  inbox_item_id: string | null
}

/** The opt-in parts of one document's read (lib/documents/read/document-detail.ts). */
export interface DocumentDetailRequest {
  include?: readonly DocumentDetailPart[]
  fromPage?: number
  maxChars?: number
  /**
   * The reader of those parts, passed in by the caller: it reads Arkiv's
   * pages and flag (the inbox block), which the ledger kernel may not import.
   * Required whenever include names a part.
   */
  readDetail?: typeof readDocumentDetail
}

function toPublic(row: DocumentRow): DocumentPublic {
  return {
    document_id: row.id,
    file_name: row.file_name,
    mime_type: row.mime_type ?? null,
    file_size_bytes: row.file_size_bytes ?? null,
    sha256_hash: row.sha256_hash,
    version: row.version,
    is_current_version: row.is_current_version === true,
    upload_source: row.upload_source ?? null,
    linked: row.journal_entry_id != null,
    journal_entry_id: row.journal_entry_id ?? null,
    journal_entry_line_id: row.journal_entry_line_id ?? null,
    created_at: row.created_at,
    doc_type: row.doc_type ?? null,
  }
}

export interface ListDocumentsFilters {
  linked?: 'true' | 'false'
  journal_entry_id?: string
  uploaded_from?: string
  uploaded_to?: string
  current_only?: 'true' | 'false'
  /**
   * Only the documents of these types, by the type readers show
   * (whereEffectiveType); null: only the ones with none. Undefined: all.
   */
  types?: readonly string[] | null
  cursor?: string
  limit?: number
}

/** The day after a YYYY-MM-DD date, for an exclusive upper bound. */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * One page of documents, newest upload first, keyset on (created_at, id)
 * descending. Current versions only unless current_only=false (the
 * dashboard list's default). A cursor that does not decode starts over.
 */
export async function listDocumentsPage(
  ctx: OperationContext,
  filters: ListDocumentsFilters,
): Promise<OperationOutcome<{ documents: DocumentPublic[]; next_cursor: string | null }>> {
  const limit = filters.limit ?? 50
  const decoded = decodeDefaultCursor(filters.cursor)
  const byType = filters.types !== undefined
  let query = ctx.supabase
    .from('document_attachments')
    .select(byType ? `${DOCUMENT_COLUMNS}, ${EFFECTIVE_TYPE_JOIN}` : DOCUMENT_COLUMNS)
    .eq('company_id', ctx.companyId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1)
  if (filters.current_only !== 'false') query = query.eq('is_current_version', true)
  if (filters.linked === 'true') query = query.not('journal_entry_id', 'is', null)
  if (filters.linked === 'false') query = query.is('journal_entry_id', null)
  if (filters.journal_entry_id) query = query.eq('journal_entry_id', filters.journal_entry_id)
  if (filters.uploaded_from) query = query.gte('created_at', `${filters.uploaded_from}T00:00:00Z`)
  if (filters.uploaded_to) query = query.lt('created_at', `${nextDay(filters.uploaded_to)}T00:00:00Z`)
  if (filters.types !== undefined) query = whereEffectiveType(query, filters.types)
  if (decoded) {
    query = query.or(`created_at.lt.${decoded.ts},and(created_at.eq.${decoded.ts},id.lt.${decoded.id})`)
  }
  const { data, error } = await query
  if (error) return failed(error)
  const rows = (data ?? []) as unknown as DocumentRow[]
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  // A booked document typed after its period closed keeps the type on its
  // classification. Strict: a page whose type failed to read would contradict
  // its own doc_type filter.
  try {
    await fillTypeFromClassification(ctx.supabase, page, { strict: true })
  } catch (err) {
    return failed(err)
  }
  return {
    ok: true,
    data: {
      documents: page.map(toPublic),
      next_cursor: rows.length > limit && last ? encodeDefaultCursor(last) : null,
    },
  }
}

/**
 * One document's metadata, with what holds it: the bank transactions it is
 * pinned to and the inbox item it arrived through. Enough to decide whether
 * it may be deleted or detached without fetching the file.
 */
export async function getDocumentMetadata(
  ctx: OperationContext,
  documentId: string,
  request: DocumentDetailRequest = {},
): Promise<OperationOutcome<DocumentDetailPublic>> {
  if (!UUID_RE.test(documentId)) return NOT_FOUND
  const { data, error } = await ctx.supabase
    .from('document_attachments')
    .select(`${DOCUMENT_COLUMNS}, original_id, superseded_by_id, digitization_date, page_count, pages_read_at, read_error, admission_state, extracted_data, extracted_at, extraction_model`)
    .eq('id', documentId)
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  if (error) return failed(error)
  if (!data) return NOT_FOUND
  const row = data as unknown as DocumentDetailRow
  // The type the list shows, read the same way (the reading below names it too).
  try {
    await fillTypeFromClassification(ctx.supabase, [row], { strict: true })
  } catch (err) {
    return failed(err)
  }

  const [{ data: txs, error: txError }, { data: inbox, error: inboxError }] = await Promise.all([
    ctx.supabase
      .from('transactions')
      .select('id')
      .eq('company_id', ctx.companyId)
      .eq('document_id', documentId),
    ctx.supabase
      .from('invoice_inbox_items')
      .select('id')
      .eq('company_id', ctx.companyId)
      .eq('document_id', documentId)
      .limit(1),
  ])
  if (txError) return failed(txError)
  if (inboxError) return failed(inboxError)

  let detail: DocumentDetail = {}
  if (request.include?.length && request.readDetail) {
    try {
      detail = await request.readDetail(
        ctx.supabase,
        ctx.companyId,
        {
          id: row.id,
          original_id: row.original_id ?? null,
          mime_type: row.mime_type ?? null,
          page_count: row.page_count ?? null,
          pages_read_at: row.pages_read_at ?? null,
          read_error: row.read_error ?? null,
          doc_type: row.doc_type ?? null,
          admission_state: row.admission_state ?? null,
          extracted_data: row.extracted_data ?? null,
          extracted_at: row.extracted_at ?? null,
          extraction_model: row.extraction_model ?? null,
          journal_entry_id: row.journal_entry_id ?? null,
          journal_entry_line_id: row.journal_entry_line_id ?? null,
        },
        {
          include: request.include,
          fromPage: request.fromPage,
          maxChars: request.maxChars,
          toRequest: toSameOriginStorageRequest,
          hints: { file: 'the file (GET /documents/{id}/download)' },
        },
      )
    } catch (err) {
      return failed(err)
    }
  }

  return {
    ok: true,
    data: {
      ...toPublic(row),
      original_id: row.original_id ?? null,
      superseded_by_id: row.superseded_by_id ?? null,
      digitization_date: row.digitization_date ?? null,
      transaction_ids: ((txs ?? []) as Array<{ id: string }>).map((t) => t.id),
      inbox_item_id: ((inbox ?? []) as Array<{ id: string }>)[0]?.id ?? null,
      ...detail,
    },
  }
}

/**
 * Delete a document nothing holds. The rule is deleteDocument()'s (the
 * dashboard's), documentDeleteRefusal() in lib/documents/deletion.ts: a link
 * to a verifikat or one of its lines answers DOC_DELETE_LINKED with the BFL
 * 7 kap 2 § explanation; the underlag of a registered supplier invoice or
 * utlägg, the file or received Peppol XML of a booked inbox item and a bank
 * transaction's underlag each answer their own code. The dry run reads the
 * same row and pins and applies the same rule, and names the inbox items
 * that go with the document (inboxItemsLeftEmpty) so the approver sees them.
 */
export async function removeDocument(
  ctx: OperationContext,
  documentId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ id: string; file_name: string; deleted: true }>> {
  if (options.dryRun) {
    // A failed read answers 404, as deleteDocument() does on the commit path.
    const { data, error } = await ctx.supabase
      .from('document_attachments')
      .select('id, file_name, journal_entry_id, journal_entry_line_id')
      .eq('id', documentId)
      .eq('company_id', ctx.companyId)
      .maybeSingle()
    if (error || !data) return NOT_FOUND
    const row = data as { id: string; file_name: string; journal_entry_id: string | null; journal_entry_line_id: string | null }
    if (!canDeleteDocument(row)) {
      return { ok: false, code: 'DOC_DELETE_LINKED', details: { journal_entry_id: row.journal_entry_id, journal_entry_line_id: row.journal_entry_line_id } }
    }
    let pins: Awaited<ReturnType<typeof readDocumentDeletePins>>
    try {
      pins = await readDocumentDeletePins(ctx.supabase, ctx.companyId, documentId)
    } catch (err) {
      return failed(err)
    }
    const refusal = documentDeleteRefusal(row, pins)
    if (refusal) return { ok: false, code: refusal.code, details: { blocked_by: refusal.block } }
    return {
      ok: true,
      dryRun: true,
      preview: {
        document_id: row.id,
        file_name: row.file_name,
        would_delete: true,
        inbox_item_ids_deleted_too: inboxItemsLeftEmpty(documentId, pins.inboxItems),
      },
    }
  }

  let result: Awaited<ReturnType<typeof deleteDocument>>
  try {
    result = await deleteDocument(ctx.supabase, ctx.companyId, documentId)
  } catch (err) {
    ctx.log.error('document delete failed', err as Error)
    return failed(err)
  }
  if (!result.ok) {
    if (result.reason === 'not_found') return NOT_FOUND
    return { ok: false, code: result.code, messageSv: result.message, details: { blocked_by: result.block } }
  }
  return { ok: true, data: { id: result.document.id, file_name: result.document.file_name, deleted: true } }
}
