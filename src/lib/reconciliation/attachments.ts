import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ISO_DATE_RE } from '@/lib/invariants'
import { createLogger } from '@/lib/logger'
import {
  ALLOWED_DOCUMENT_TYPES,
  DOCUMENTS_BUCKET,
  computeSHA256,
  sanitizeFileName,
  validateDocumentFile,
  validateDocumentMagicBytes,
} from '@/lib/core/documents/document-service'
import { downloadCompanyFolderObject } from '@/lib/core/documents/storage-key'
import { parseAccountKey, type ReconciliationAttachment } from './schemas'
import {
  getAttachmentRow,
  insertAttachmentRow,
  listAttachmentRows,
  stampAttachmentRemoved,
  toPublicAttachment,
  type AttachmentRow,
} from './attachments-store'

const log = createLogger('reconciliation/attachments')

/**
 * Underlag on a reconciliation balansdag: the bytes go to the company-scoped
 * `documents` bucket (same validation and hashing as every other document in
 * the archive), the row to account_reconciliation_attachments. The policy
 * layer over attachments-store.ts: what may be attached, where it lives, and
 * that removal is a stamp, never a delete.
 *
 * Storage keys start with `documents/<company_id>/` on purpose: the bucket's
 * RLS grants INSERT/SELECT on the second path segment being one of the
 * caller's companies, so the auth-bound client can upload without the
 * service role. Reads for the inline route and the archive go through the
 * service role after the row has authorized the caller.
 */

export const MAX_ATTACHMENT_NOTE_LENGTH = 500

export type AttachmentErrorCode = 'INVALID_ACCOUNT_KEY' | 'INVALID_DATE' | 'INVALID_FILE' | 'NOTE_TOO_LONG' | 'ALREADY_REMOVED'

export class ReconciliationAttachmentError extends Error {
  readonly code: AttachmentErrorCode
  constructor(message: string, code: AttachmentErrorCode) {
    super(message)
    this.name = 'ReconciliationAttachmentError'
    this.code = code
  }
}

/**
 * The name the user sees in the list and gets on download: kept as uploaded
 * (å, ä, ö, spaces and all), minus path separators and control characters.
 * Never a storage key: see attachmentStoragePath.
 */
function displayFileName(name: string): string {
  const trimmed = name.trim().replace(/[/\\]/g, '_').replace(/[\u0000-\u001f]/g, '')
  return (trimmed || 'underlag').slice(0, 180)
}

/**
 * `manual:2350` is a fine key but a poor path segment; keep the key readable
 * without the colon. The file name goes through the archive's storage-key
 * sanitiser: Supabase Storage refuses keys with non-ASCII ("Invalid key"),
 * which turned every Swedish file name (Skattekontoutdrag från Byrån.pdf)
 * into a failed upload.
 */
export function attachmentStoragePath(
  companyId: string,
  accountKey: string,
  throughDate: string,
  fileName: string,
  id: string = randomUUID(),
): string {
  const keySegment = accountKey.replace(':', '_')
  return `documents/${companyId}/reconciliation/${keySegment}/${throughDate}/${id}_${sanitizeFileName(fileName)}`
}

function assertScope(accountKey: string, throughDate: string): void {
  if (!parseAccountKey(accountKey)) {
    throw new ReconciliationAttachmentError('Okänt konto.', 'INVALID_ACCOUNT_KEY')
  }
  if (!ISO_DATE_RE.test(throughDate) || Number.isNaN(Date.parse(throughDate))) {
    throw new ReconciliationAttachmentError('Ogiltigt datum. Ange ÅÅÅÅ-MM-DD.', 'INVALID_DATE')
  }
}

export async function listAttachments(
  supabase: SupabaseClient,
  companyId: string,
  accountKey: string,
  throughDate: string,
  options: { includeRemoved?: boolean } = {},
): Promise<ReconciliationAttachment[]> {
  assertScope(accountKey, throughDate)
  const rows = await listAttachmentRows(supabase, companyId, accountKey, throughDate, options)
  return rows.map(toPublicAttachment)
}

export interface AttachInput {
  through_date: string
  file: { name: string; type: string; size: number; buffer: ArrayBuffer }
  note?: string | null
}

/**
 * Validate, hash, upload, record. The row is written after the object so a
 * failed upload leaves nothing behind; a failed insert after a successful
 * upload is logged with the key (the object is harmless: nothing points at it).
 */
export async function attachUnderlag(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  accountKey: string,
  input: AttachInput,
): Promise<ReconciliationAttachment> {
  assertScope(accountKey, input.through_date)
  const note = input.note?.trim() ? input.note.trim() : null
  if (note && note.length > MAX_ATTACHMENT_NOTE_LENGTH) {
    throw new ReconciliationAttachmentError('Noteringen är för lång.', 'NOTE_TOO_LONG')
  }
  const sizeError = validateDocumentFile({ size: input.file.size, type: input.file.type })
  if (sizeError) throw new ReconciliationAttachmentError(sizeError, 'INVALID_FILE')
  if (!ALLOWED_DOCUMENT_TYPES.includes(input.file.type)) {
    throw new ReconciliationAttachmentError('Filtypen stöds inte. Ladda upp PDF, JPEG, PNG eller WebP.', 'INVALID_FILE')
  }
  const magicError = validateDocumentMagicBytes(input.file.buffer, input.file.type)
  if (magicError) throw new ReconciliationAttachmentError(magicError, 'INVALID_FILE')

  const sha256 = await computeSHA256(input.file.buffer)
  const storagePath = attachmentStoragePath(companyId, accountKey, input.through_date, input.file.name)

  const { error: uploadError } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(storagePath, input.file.buffer, { contentType: input.file.type, upsert: false })
  if (uploadError) {
    throw new Error(`Kunde inte ladda upp underlaget: ${uploadError.message}`)
  }

  try {
    const row = await insertAttachmentRow(supabase, companyId, {
      account_key: accountKey,
      through_date: input.through_date,
      file_name: displayFileName(input.file.name),
      mime_type: input.file.type,
      size_bytes: input.file.size,
      storage_bucket: DOCUMENTS_BUCKET,
      storage_path: storagePath,
      sha256,
      note,
      uploaded_by: userId,
    })
    return toPublicAttachment(row)
  } catch (err) {
    log.error('attachment row insert failed after upload', err, { companyId, accountKey, storagePath })
    throw err
  }
}

/** Removal keeps the row and the object; the stamp says who and why. Null when the id does not resolve. */
export async function removeUnderlag(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  accountKey: string,
  attachmentId: string,
  input: { reason?: string | null } = {},
): Promise<ReconciliationAttachment | null> {
  if (!parseAccountKey(accountKey)) return null
  const existing = await getAttachmentRow(supabase, companyId, accountKey, attachmentId)
  if (!existing) return null
  if (existing.removed_at) {
    throw new ReconciliationAttachmentError('Underlaget är redan borttaget.', 'ALREADY_REMOVED')
  }
  const reason = input.reason?.trim() ? input.reason.trim() : null
  const updated = await stampAttachmentRemoved(supabase, companyId, attachmentId, { removed_by: userId, reason })
  return updated ? toPublicAttachment(updated) : null
}

/**
 * The bytes of one attachment, for the inline route and the archive. Takes
 * the row (already authorized through the caller's client) and a service
 * client for the bucket read. Only a key in the company's own folder of the
 * documents bucket is read (storage-key.ts): where uploadUnderlag puts it.
 */
export async function downloadUnderlag(
  serviceClient: SupabaseClient,
  row: Pick<AttachmentRow, 'storage_bucket' | 'storage_path'>,
  companyId: string,
): Promise<{ blob: Blob | null; error: Error | null }> {
  const { blob, error } = await downloadCompanyFolderObject(serviceClient, row.storage_bucket, row.storage_path, companyId)
  if (!blob) return { blob: null, error: new Error(error?.message ?? 'Download returned no data') }
  return { blob, error: null }
}
