/**
 * The PDF a signing request covers, read from the archive with the service
 * role: the current version of a PDF in the company's archive, at most
 * SIGNING_MAX_DOCUMENT_BYTES, whose stored bytes still hash to the row's
 * sha256_hash, and that opens without a password (the signed copy is built
 * from it with pdf-lib).
 */
import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SIGNING_MAX_DOCUMENT_BYTES } from './types'

export interface SignableDocument {
  id: string
  company_id: string
  user_id: string
  file_name: string
  sha256_hash: string
  bytes: Uint8Array
}

export type SignableDocumentResult =
  | { ok: true; document: SignableDocument }
  | { ok: false; code: 'SIGNING_DOCUMENT_NOT_FOUND' | 'SIGNING_DOCUMENT_UNSUPPORTED' | 'SIGNING_DOCUMENT_CHANGED' }

interface DocumentRow {
  id: string
  company_id: string
  user_id: string
  file_name: string
  mime_type: string | null
  file_size_bytes: number | null
  storage_path: string
  sha256_hash: string
  is_current_version: boolean
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The stored bytes of an archived document, or null when storage has none. */
export async function downloadDocumentBytes(service: SupabaseClient, storagePath: string): Promise<Uint8Array | null> {
  const { data, error } = await service.storage.from('documents').download(storagePath)
  if (error || !data) return null
  return new Uint8Array(await data.arrayBuffer())
}

/** Whether pdf-lib opens the PDF without a password. */
export async function opensWithoutPassword(bytes: Uint8Array): Promise<boolean> {
  try {
    const { PDFDocument } = await import('pdf-lib')
    await PDFDocument.load(bytes, { updateMetadata: false })
    return true
  } catch {
    return false
  }
}

export async function loadSignableDocument(
  service: SupabaseClient,
  companyId: string,
  documentId: string,
  options: { requireCurrentVersion?: boolean; expectedSha256?: string; checkBytes?: boolean } = {},
): Promise<SignableDocumentResult> {
  const { data, error } = await service
    .from('document_attachments')
    .select('id, company_id, user_id, file_name, mime_type, file_size_bytes, storage_path, sha256_hash, is_current_version')
    .eq('company_id', companyId)
    .eq('id', documentId)
    .maybeSingle()
  if (error) throw error
  const row = data as DocumentRow | null
  if (!row) return { ok: false, code: 'SIGNING_DOCUMENT_NOT_FOUND' }
  if (row.mime_type !== 'application/pdf') return { ok: false, code: 'SIGNING_DOCUMENT_UNSUPPORTED' }
  if ((options.requireCurrentVersion ?? true) && !row.is_current_version) return { ok: false, code: 'SIGNING_DOCUMENT_UNSUPPORTED' }
  if (row.file_size_bytes !== null && row.file_size_bytes > SIGNING_MAX_DOCUMENT_BYTES) return { ok: false, code: 'SIGNING_DOCUMENT_UNSUPPORTED' }
  // A preview reads the row only; the bytes are checked when the request is made.
  if (options.checkBytes === false) {
    return {
      ok: true,
      document: { id: row.id, company_id: row.company_id, user_id: row.user_id, file_name: row.file_name, sha256_hash: row.sha256_hash, bytes: new Uint8Array() },
    }
  }

  const bytes = await downloadDocumentBytes(service, row.storage_path)
  if (!bytes) return { ok: false, code: 'SIGNING_DOCUMENT_NOT_FOUND' }
  if (bytes.byteLength > SIGNING_MAX_DOCUMENT_BYTES) return { ok: false, code: 'SIGNING_DOCUMENT_UNSUPPORTED' }
  const hash = sha256Hex(bytes)
  if (hash !== row.sha256_hash || (options.expectedSha256 && hash !== options.expectedSha256)) {
    return { ok: false, code: 'SIGNING_DOCUMENT_CHANGED' }
  }
  if (!(await opensWithoutPassword(bytes))) return { ok: false, code: 'SIGNING_DOCUMENT_UNSUPPORTED' }
  return {
    ok: true,
    document: { id: row.id, company_id: row.company_id, user_id: row.user_id, file_name: row.file_name, sha256_hash: row.sha256_hash, bytes },
  }
}
