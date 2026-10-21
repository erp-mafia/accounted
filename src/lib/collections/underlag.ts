import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { downloadDocumentObject, linkToJournalEntry, uploadDocument } from '@/lib/core/documents/document-service'
import { createLogger, type Logger } from '@/lib/logger'
import { linkBasisColumns } from '@/lib/links/stamp'

/**
 * Underlag for the collections vouchers: link an archived document to a
 * voucher once, and copy a document onto another voucher (a document row
 * links to one voucher, so the settlement PDF reaches the C vouchers it
 * settles as copies). Both are safe to run again after a crash.
 */

const log = createLogger('collections/underlag')

/**
 * Link an archived document to a voucher as its underlag, unless it already
 * is. A document already on another voucher is left there (WORM: a link is
 * never moved) and answers false.
 */
export async function linkDocumentOnce(
  db: SupabaseClient,
  companyId: string,
  documentId: string | null,
  journalEntryId: string,
  logger: Logger = log,
): Promise<boolean> {
  if (!documentId) return false
  const { data, error } = await db
    .from('document_attachments')
    .select('journal_entry_id')
    .eq('company_id', companyId)
    .eq('id', documentId)
    .maybeSingle()
  if (error) throw new Error(`document_attachments lookup failed: ${error.message}`)
  const linkedTo = (data as { journal_entry_id: string | null } | null)?.journal_entry_id ?? null
  if (linkedTo === journalEntryId) return true
  if (linkedTo) {
    logger.warn('document already sits on another voucher', { documentId, journalEntryId })
    return false
  }
  await linkToJournalEntry(db, companyId, documentId, journalEntryId, linkBasisColumns('system_derived'))
  return true
}

export interface CopyDocumentInput {
  companyId: string
  userId: string
  documentId: string
  journalEntryId: string
  /** Scopes the copy; with the voucher and the content it makes the copy's id deterministic. */
  scope: string
}

/**
 * Archive a copy of an archived document, linked to another voucher.
 * Idempotent: the copy's id is deterministic for (company, scope and voucher,
 * content), so a run that died after the copy finds it again instead of
 * archiving a second one. The bytes are checked against the recorded hash.
 */
export async function copyDocumentToVoucher(db: SupabaseClient, input: CopyDocumentInput): Promise<string> {
  const { data, error } = await db
    .from('document_attachments')
    .select('id, storage_path, file_name, mime_type, sha256_hash')
    .eq('company_id', input.companyId)
    .eq('id', input.documentId)
    .maybeSingle()
  if (error) throw new Error(`document_attachments lookup failed: ${error.message}`)
  const row = data as { storage_path: string; file_name: string; mime_type: string | null; sha256_hash: string } | null
  if (!row) throw new Error(`document ${input.documentId} not found`)
  const { blob, error: downloadError } = await downloadDocumentObject(db, row.storage_path, input.companyId)
  if (!blob) throw new Error(`document ${input.documentId} unreadable: ${downloadError?.message ?? 'no data'}`)
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== row.sha256_hash) {
    throw new Error(`document ${input.documentId} does not match its recorded hash`)
  }
  const copy = await uploadDocument(
    db,
    input.userId,
    input.companyId,
    { name: row.file_name, buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, type: row.mime_type ?? 'application/pdf' },
    {
      upload_source: 'system',
      journal_entry_id: input.journalEntryId,
      linkBasis: linkBasisColumns('system_derived'),
      idempotency_key: `${input.scope}:${input.journalEntryId}`,
      extractionOwner: 'none',
    },
  )
  return copy.id
}
