import type { SupabaseClient } from '@supabase/supabase-js'
import { downloadDocumentObject } from '@/lib/core/documents/document-service'
import {
  MAX_INVOICE_ATTACHMENTS,
  MAX_INVOICE_ATTACHMENTS_TOTAL_BYTES,
} from '@/lib/invoices/invoice-attachment-limits'

/**
 * Files emailed with a customer invoice after its own PDF (crm#1269): a time
 * report, a specification, a copy of a receipt that is invoiced onward.
 *
 * The files are ordinary documents of the archive (uploaded through the
 * existing pipeline: size, type and content checks, WORM bucket) linked to
 * the invoice through invoice_attachments. They belong to the invoice, not to
 * one send: every email delivery of the invoice carries them, in the order
 * they were added. The set changes only while the invoice is a draft that has
 * never been emailed; after that the database freezes the links and refuses
 * to delete their documents (migration 20261016224500), because what the
 * customer received with the invoice is räkenskapsinformation (BFL 7 kap).
 *
 * Peppol and the PDF download are unchanged: only the email carries them.
 */

export { MAX_INVOICE_ATTACHMENTS, MAX_INVOICE_ATTACHMENTS_TOTAL_BYTES }

export interface InvoiceAttachment {
  document_id: string
  file_name: string
  mime_type: string | null
  file_size_bytes: number | null
  created_at: string
}

export interface InvoiceEmailAttachmentFile {
  filename: string
  content: Buffer
  contentType: string
}

export type InvoiceAttachmentErrorCode =
  | 'INVOICE_NOT_FOUND'
  | 'INVOICE_ATTACHMENTS_FIXED'
  | 'INVOICE_ATTACHMENT_DOCUMENT_NOT_FOUND'
  | 'INVOICE_ATTACHMENT_NOT_FOUND'
  | 'INVOICE_ATTACHMENTS_TOO_MANY'
  | 'INVOICE_ATTACHMENTS_TOO_LARGE'
  | 'INVOICE_ATTACHMENT_LOAD_FAILED'

export type InvoiceAttachmentResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: InvoiceAttachmentErrorCode }

interface AttachmentRow {
  document_id: string
  created_at: string
  document: {
    file_name: string
    mime_type: string | null
    file_size_bytes: number | null
    storage_path?: string
  } | null
}

const fail = (code: InvoiceAttachmentErrorCode) => ({ ok: false as const, code })

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The guard trigger's refusal of a change to an issued or emailed invoice's
 * attachments. The app checks the invoice status first; this catches the one
 * case it cannot see (a draft emailed before, whose delivery rows RLS shows
 * only to the sender) and a send racing the change.
 */
function isFixedRefusal(error: { code?: string; message?: string } | null): boolean {
  return (
    !!error &&
    error.code === '23514' &&
    /fixed once the invoice|retention: an issued or emailed invoice/.test(error.message ?? '')
  )
}

function totalBytes(sizes: Array<number | null | undefined>): number {
  return sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0)
}

async function fetchAttachmentRows(
  supabase: SupabaseClient,
  companyId: string,
  invoiceId: string,
): Promise<AttachmentRow[]> {
  const { data, error } = await supabase
    .from('invoice_attachments')
    .select('document_id, created_at, document:document_attachments(file_name, mime_type, file_size_bytes, storage_path)')
    .eq('company_id', companyId)
    .eq('invoice_id', invoiceId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
  if (error) throw error
  return (data ?? []) as unknown as AttachmentRow[]
}

function toAttachment(row: AttachmentRow): InvoiceAttachment {
  return {
    document_id: row.document_id,
    file_name: row.document?.file_name ?? '',
    mime_type: row.document?.mime_type ?? null,
    file_size_bytes: row.document?.file_size_bytes ?? null,
    created_at: row.created_at,
  }
}

/** The invoice's attachments, oldest first (the order they are emailed in). */
export async function listInvoiceAttachments(
  supabase: SupabaseClient,
  companyId: string,
  invoiceId: string,
): Promise<InvoiceAttachment[]> {
  const rows = await fetchAttachmentRows(supabase, companyId, invoiceId)
  return rows.map(toAttachment)
}

/**
 * The invoice exists in the company and its attachments may still change.
 * Only a draft qualifies; the database refuses the rest of the fixed cases.
 */
async function checkEditableInvoice(
  supabase: SupabaseClient,
  companyId: string,
  invoiceId: string,
): Promise<InvoiceAttachmentErrorCode | null> {
  const { data, error } = await supabase
    .from('invoices')
    .select('id, status')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw error
  if (!data) return 'INVOICE_NOT_FOUND'
  if ((data as { status: string }).status !== 'draft') return 'INVOICE_ATTACHMENTS_FIXED'
  return null
}

/**
 * Attach archived documents to a draft invoice. Documents already attached
 * are left as they are, so repeating a call is harmless. Every document must
 * be a current version in the same company: an id from another company is
 * answered exactly like an id that does not exist.
 *
 * With `dryRun` every check runs and nothing is written (the v1 dry run and
 * the MCP staging step); the value is then the set the invoice would carry.
 */
export async function linkInvoiceAttachments(
  supabase: SupabaseClient,
  companyId: string,
  invoiceId: string,
  documentIds: string[],
  options: { dryRun?: boolean } = {},
): Promise<InvoiceAttachmentResult<InvoiceAttachment[]>> {
  const wanted = [...new Set(documentIds)]
  // Nothing asked for: the set as it stands, whatever the invoice's state.
  if (wanted.length === 0) {
    return { ok: true, value: await listInvoiceAttachments(supabase, companyId, invoiceId) }
  }
  // A malformed id cannot name a document (and would fail the lookup as 22P02).
  if (wanted.some((id) => !UUID_PATTERN.test(id))) return fail('INVOICE_ATTACHMENT_DOCUMENT_NOT_FOUND')

  const notEditable = await checkEditableInvoice(supabase, companyId, invoiceId)
  if (notEditable) return fail(notEditable)

  const existing = await listInvoiceAttachments(supabase, companyId, invoiceId)
  const attached = new Set(existing.map((a) => a.document_id))
  const added = wanted.filter((id) => !attached.has(id))
  if (added.length === 0) return { ok: true, value: existing }

  const { data: docs, error: docsError } = await supabase
    .from('document_attachments')
    .select('id, file_name, mime_type, file_size_bytes, created_at, is_current_version')
    .eq('company_id', companyId)
    .in('id', added)
  if (docsError) throw docsError
  const found = new Map(
    ((docs ?? []) as Array<{
      id: string
      file_name: string
      mime_type: string | null
      file_size_bytes: number | null
      created_at: string
      is_current_version: boolean | null
    }>)
      // A superseded version is history, not something to send.
      .filter((d) => d.is_current_version !== false)
      .map((d) => [d.id, d]),
  )
  if (added.some((id) => !found.has(id))) return fail('INVOICE_ATTACHMENT_DOCUMENT_NOT_FOUND')

  if (existing.length + added.length > MAX_INVOICE_ATTACHMENTS) {
    return fail('INVOICE_ATTACHMENTS_TOO_MANY')
  }
  const total = totalBytes([
    ...existing.map((a) => a.file_size_bytes),
    ...added.map((id) => found.get(id)!.file_size_bytes),
  ])
  if (total > MAX_INVOICE_ATTACHMENTS_TOTAL_BYTES) return fail('INVOICE_ATTACHMENTS_TOO_LARGE')

  if (options.dryRun) {
    return {
      ok: true,
      value: [
        ...existing,
        ...added.map((id) => {
          const d = found.get(id)!
          return {
            document_id: d.id,
            file_name: d.file_name,
            mime_type: d.mime_type,
            file_size_bytes: d.file_size_bytes,
            created_at: d.created_at,
          }
        }),
      ],
    }
  }

  // One row at a time, in the order given: created_at orders the email.
  for (const documentId of added) {
    const { error } = await supabase
      .from('invoice_attachments')
      .insert({ company_id: companyId, invoice_id: invoiceId, document_id: documentId })
    if (!error) continue
    // A concurrent call attached the same document: the outcome is the same.
    if ((error as { code?: string }).code === '23505') continue
    if (isFixedRefusal(error)) return fail('INVOICE_ATTACHMENTS_FIXED')
    throw error
  }

  return { ok: true, value: await listInvoiceAttachments(supabase, companyId, invoiceId) }
}

/**
 * Remove an attachment from a draft invoice. Only the link goes: the
 * document stays in the archive like any other upload.
 */
export async function unlinkInvoiceAttachment(
  supabase: SupabaseClient,
  companyId: string,
  invoiceId: string,
  documentId: string,
): Promise<InvoiceAttachmentResult<null>> {
  const notEditable = await checkEditableInvoice(supabase, companyId, invoiceId)
  if (notEditable) return fail(notEditable)

  const { data, error } = await supabase
    .from('invoice_attachments')
    .delete()
    .eq('company_id', companyId)
    .eq('invoice_id', invoiceId)
    .eq('document_id', documentId)
    .select('id')
  if (error) {
    if (isFixedRefusal(error)) return fail('INVOICE_ATTACHMENTS_FIXED')
    throw error
  }
  if (!data || data.length === 0) return fail('INVOICE_ATTACHMENT_NOT_FOUND')
  return { ok: true, value: null }
}

/**
 * The invoice's attachments as email attachments, read from the archive.
 * Called by every send path BEFORE the invoice number is allocated and the
 * invoice issued, so a missing or oversized file stops the send while nothing
 * irreversible has happened. The sizes are checked on the bytes actually
 * read, not on the stored metadata.
 */
export async function loadInvoiceEmailAttachments(
  supabase: SupabaseClient,
  companyId: string,
  invoiceId: string,
): Promise<InvoiceAttachmentResult<InvoiceEmailAttachmentFile[]>> {
  const rows = await fetchAttachmentRows(supabase, companyId, invoiceId)
  if (rows.length === 0) return { ok: true, value: [] }
  if (rows.length > MAX_INVOICE_ATTACHMENTS) return fail('INVOICE_ATTACHMENTS_TOO_MANY')
  if (totalBytes(rows.map((r) => r.document?.file_size_bytes)) > MAX_INVOICE_ATTACHMENTS_TOTAL_BYTES) {
    return fail('INVOICE_ATTACHMENTS_TOO_LARGE')
  }

  const files: InvoiceEmailAttachmentFile[] = []
  for (const row of rows) {
    const storagePath = row.document?.storage_path
    if (!storagePath) return fail('INVOICE_ATTACHMENT_LOAD_FAILED')
    const { blob } = await downloadDocumentObject(supabase, storagePath, companyId)
    if (!blob) return fail('INVOICE_ATTACHMENT_LOAD_FAILED')
    files.push({
      filename: row.document!.file_name,
      content: Buffer.from(await blob.arrayBuffer()),
      contentType: row.document!.mime_type || 'application/octet-stream',
    })
  }

  if (totalBytes(files.map((f) => f.content.byteLength)) > MAX_INVOICE_ATTACHMENTS_TOTAL_BYTES) {
    return fail('INVOICE_ATTACHMENTS_TOO_LARGE')
  }
  return { ok: true, value: files }
}
