import type { SupabaseClient } from '@supabase/supabase-js'
import { DOC_TYPES, isDocType } from '@/lib/documents/classify/taxonomy'
import { NOT_STRUCTURED_MIME_FILTER } from '@/lib/documents/read/types'
import { FOLDER_ORDER, folderFor, type FolderKey } from './folders'

/**
 * Every document of a kind or period, complete and in pages (2026-09-24).
 * Search ranks pages and stops at a cap, so "every Bolagsverket filing" or
 * "every receipt uploaded in May" came back partial; an agent gathering
 * documents pages through this instead. It lists raw facts about the file
 * only: its name, type, upload time, page count, whether it has been read,
 * the verifikat it sits on, and whether the same text is already archived
 * under another row. Nothing a model read out of it.
 */
export const LIST_LIMIT_DEFAULT = 100
export const LIST_LIMIT_MAX = 200

export interface ListedRecord {
  record_ref: string
  file_name: string
  doc_type: string | null
  uploaded_at: string
  page_count: number | null
  read: boolean
  voucher: string | null
  /** The earliest archived document with the same file or the same text; set on the later copies, so a sum counts each once. */
  duplicate_of: string | null
}

export interface ListRecordsResult {
  items: ListedRecord[]
  total: number
  next_offset: number | null
}

export interface ListRecordsOptions {
  /** A doc_type (receipt, agreement.loan...) or a folder (agreements, authority, corporate, receipts, supplier_invoices, customer_invoices, bank_statements, other, untyped). */
  type?: string | null
  uploadedFrom?: string | null
  uploadedTo?: string | null
  fileNameContains?: string | null
  offset?: number
  limit?: number
}

export const isFolderKey = (value: string): value is FolderKey => (FOLDER_ORDER as readonly string[]).includes(value)

/** The doc_types a type filter stands for; null for untyped, undefined for no filter. */
export function typesFor(type: string | null | undefined): string[] | null | undefined {
  if (!type) return undefined
  if (type === 'untyped') return null
  if (isDocType(type)) return [type]
  if (isFolderKey(type)) return DOC_TYPES.filter((t) => folderFor(t) === type)
  throw new Error(`Unknown type "${type}": pass a doc_type or one of ${FOLDER_ORDER.join(', ')}`)
}

export async function listRecords(supabase: SupabaseClient, companyId: string, opts: ListRecordsOptions = {}): Promise<ListRecordsResult> {
  const limit = Math.min(LIST_LIMIT_MAX, Math.max(1, Math.floor(opts.limit ?? LIST_LIMIT_DEFAULT)))
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  const types = typesFor(opts.type)

  let query = supabase
    .from('document_attachments')
    .select('id, file_name, doc_type, created_at, page_count, pages_read_at, read_error, journal_entry_id, sha256_hash', { count: 'exact' })
    .eq('company_id', companyId)
    .in('admission_state', ['admitted', 'held'])
    .or(NOT_STRUCTURED_MIME_FILTER)
  if (types === null) query = query.is('doc_type', null)
  else if (types) query = query.in('doc_type', types)
  if (opts.uploadedFrom) query = query.gte('created_at', opts.uploadedFrom)
  if (opts.uploadedTo) query = query.lt('created_at', `${opts.uploadedTo}T23:59:59.999Z`)
  if (opts.fileNameContains) query = query.ilike('file_name', `%${opts.fileNameContains.replace(/[%_\\]/g, (c) => `\\${c}`)}%`)
  const { data, error, count } = await query.order('created_at', { ascending: false }).order('id', { ascending: true }).range(offset, offset + limit - 1)
  if (error) throw new Error(`list failed: ${error.message}`)
  const rows = (data ?? []) as Array<{
    id: string
    file_name: string
    doc_type: string | null
    created_at: string
    page_count: number | null
    pages_read_at: string | null
    read_error: string | null
    journal_entry_id: string | null
    sha256_hash: string | null
  }>
  const total = count ?? rows.length
  if (rows.length === 0) return { items: [], total, next_offset: null }

  const entryIds = [...new Set(rows.map((r) => r.journal_entry_id).filter((id): id is string => !!id))]
  const [entries, originals] = await Promise.all([
    entryIds.length ? supabase.from('journal_entries').select('id, voucher_series, voucher_number').in('id', entryIds) : Promise.resolve({ data: [], error: null }),
    originalsOf(supabase, companyId, rows),
  ])
  if (entries.error) throw new Error(`list failed: ${entries.error.message}`)
  const voucherOf = new Map(((entries.data ?? []) as Array<{ id: string; voucher_series: string | null; voucher_number: number | null }>).map((e) => [e.id, `${e.voucher_series ?? ''}${e.voucher_number ?? ''}`]))

  const items = rows.map((r) => ({
    record_ref: `document:${r.id}`,
    file_name: r.file_name,
    doc_type: r.doc_type,
    uploaded_at: r.created_at,
    page_count: r.page_count,
    read: !!r.pages_read_at && !r.read_error,
    voucher: r.journal_entry_id ? (voucherOf.get(r.journal_entry_id) ?? null) : null,
    duplicate_of: originals.has(r.id) ? `document:${originals.get(r.id)}` : null,
  }))
  return { items, total, next_offset: offset + rows.length < total ? offset + rows.length : null }
}

/**
 * The earliest archived copy of each document that has one, by the same file (byte hash) or the same text
 * (content hash): id -> original id. Used wherever documents are listed to an agent (list_records, a
 * verifikat's attachments, search hits), so a sum counts each document once (prod 2026-09-25: verifikat A82
 * carried one invoice twice, and a naive sum doubled it).
 */
export async function originalsOf(
  supabase: SupabaseClient,
  companyId: string,
  rows: Array<{ id: string; created_at: string; sha256_hash: string | null }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (rows.length === 0) return out
  const ids = rows.map((r) => r.id)
  const { data: hashes, error: hashError } = await supabase
    .from('document_classifications')
    .select('document_id, content_sha256')
    .in('document_id', ids)
    .eq('is_current', true)
    .not('content_sha256', 'is', null)
  if (hashError) throw new Error(`duplicates failed: ${hashError.message}`)
  const hashOf = new Map(((hashes ?? []) as Array<{ document_id: string; content_sha256: string }>).map((h) => [h.document_id, h.content_sha256]))

  // The first archived document with each text is the original; every later one points at it.
  const canonical = new Map<string, { id: string; created_at: string }>()
  const uniqueHashes = [...new Set(hashOf.values())]
  if (uniqueHashes.length) {
    const { data: twins, error: twinError } = await supabase
      .from('document_classifications')
      .select('document_id, content_sha256')
      .eq('company_id', companyId)
      .eq('is_current', true)
      .in('content_sha256', uniqueHashes)
    if (twinError) throw new Error(`duplicates failed: ${twinError.message}`)
    const twinRows = (twins ?? []) as Array<{ document_id: string; content_sha256: string }>
    const twinIds = [...new Set(twinRows.map((t) => t.document_id))]
    if (twinIds.length > 1) {
      const { data: docs, error: docError } = await supabase.from('document_attachments').select('id, created_at').eq('company_id', companyId).in('id', twinIds)
      if (docError) throw new Error(`duplicates failed: ${docError.message}`)
      const createdAt = new Map(((docs ?? []) as Array<{ id: string; created_at: string }>).map((d) => [d.id, d.created_at]))
      for (const t of twinRows) {
        const at = createdAt.get(t.document_id)
        if (!at) continue
        const current = canonical.get(t.content_sha256)
        if (!current || at < current.created_at || (at === current.created_at && t.document_id < current.id)) canonical.set(t.content_sha256, { id: t.document_id, created_at: at })
      }
    }
  }

  // The same file sent twice has the same bytes, whatever a reader made of a photo each time (prod: one
  // receipt photo archived four times, read four slightly different ways, so its text hashes differed).
  const byteOriginal = new Map<string, { id: string; created_at: string }>()
  const byteHashes = [...new Set(rows.map((r) => r.sha256_hash).filter((h): h is string => !!h))]
  if (byteHashes.length) {
    const { data: same, error: sameError } = await supabase.from('document_attachments').select('id, created_at, sha256_hash').eq('company_id', companyId).in('sha256_hash', byteHashes)
    if (sameError) throw new Error(`duplicates failed: ${sameError.message}`)
    for (const d of (same ?? []) as Array<{ id: string; created_at: string; sha256_hash: string }>) {
      const current = byteOriginal.get(d.sha256_hash)
      if (!current || d.created_at < current.created_at || (d.created_at === current.created_at && d.id < current.id)) byteOriginal.set(d.sha256_hash, { id: d.id, created_at: d.created_at })
    }
  }

  for (const r of rows) {
    const hash = hashOf.get(r.id)
    const byText = hash ? canonical.get(hash) : undefined
    const byBytes = r.sha256_hash ? byteOriginal.get(r.sha256_hash) : undefined
    // Whichever copy was archived first is the original.
    const candidates = [byText, byBytes].filter((c): c is { id: string; created_at: string } => !!c && c.id !== r.id)
    candidates.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1))
    const first = candidates[0]
    if (first && (first.created_at < r.created_at || (first.created_at === r.created_at && first.id < r.id))) out.set(r.id, first.id)
  }
  return out
}

