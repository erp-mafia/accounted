import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { eventBus } from '@/lib/events'
import type { DocumentAttachment, DocumentUploadSource } from '@/types'

/**
 * Document Service - WORM-style document archive
 *
 * Handles document upload with SHA-256 integrity, version chains,
 * and linking to journal entries. Deletion is blocked by DB triggers
 * for documents linked to committed entries.
 */

/**
 * Sanitize a filename for use in Supabase Storage keys.
 * Replaces spaces and non-ASCII characters with underscores,
 * collapses consecutive underscores, and truncates to avoid
 * exceeding Supabase Storage path length limits.
 */
function sanitizeFileName(name: string): string {
  const dotIndex = name.lastIndexOf('.')
  const ext = dotIndex > 0 ? name.slice(dotIndex) : ''
  const base = dotIndex > 0 ? name.slice(0, dotIndex) : name

  const sanitizedBase = base
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 100) || 'file'
  const sanitizedExt = ext.replace(/[^a-zA-Z0-9.]/g, '_')

  return sanitizedBase + sanitizedExt
}

export const MAX_DOCUMENT_SIZE = 10 * 1024 * 1024 // 10 MB
export const ALLOWED_DOCUMENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]

/**
 * Validate file size and MIME type before upload.
 * Returns an error string or null if valid.
 */
export function validateDocumentFile(file: { size: number; type?: string }): string | null {
  if (file.size === 0) {
    return 'Filen är tom'
  }
  if (file.size > MAX_DOCUMENT_SIZE) {
    return `Filen är för stor (max ${MAX_DOCUMENT_SIZE / 1024 / 1024} MB)`
  }
  if (!file.type || !ALLOWED_DOCUMENT_TYPES.includes(file.type)) {
    return 'Otillåten filtyp. Tillåtna: PDF, JPG, PNG, WebP.'
  }
  return null
}

/**
 * Inspect the first bytes of a buffer to identify the actual file format.
 * Defends against callers (typically MCP agents) that base64-encode a text
 * placeholder or summary instead of the real binary file — those uploads
 * succeed at the storage layer but the bytes are unreadable as a PDF/image.
 */
function detectFileMagic(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null
  // PDF: %PDF-  (allow a leading UTF-8 BOM as some tools prepend one)
  const offset = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF ? 3 : 0
  if (
    bytes.length >= offset + 5 &&
    bytes[offset] === 0x25 &&
    bytes[offset + 1] === 0x50 &&
    bytes[offset + 2] === 0x44 &&
    bytes[offset + 3] === 0x46 &&
    bytes[offset + 4] === 0x2D
  ) return 'application/pdf'
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png'
  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg'
  // WebP: RIFF<4-byte size>WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp'
  return null
}

/**
 * Verify the buffer actually contains a file of the declared type.
 * Returns an error string or null if valid. HEIC has many ftyp brands so
 * we skip the check for now — the UI path doesn't allow HEIC anyway, only
 * the MCP upload tool does, and corrupted HEIC has not been observed.
 */
export function validateDocumentMagicBytes(buffer: ArrayBuffer, declaredMimeType: string): string | null {
  if (declaredMimeType === 'image/heic') return null
  const detected = detectFileMagic(new Uint8Array(buffer))
  if (!detected) {
    return `Filinnehållet kunde inte verifieras som ${declaredMimeType}. Filen verkar vara skadad eller inte en riktig binärfil — vid uppladdning via API, kontrollera att file_content_base64 är base64-kodade råbytes, inte en textrepresentation.`
  }
  if (detected !== declaredMimeType) {
    return `Filinnehållet matchar inte den angivna filtypen (förväntade ${declaredMimeType}, hittade ${detected}).`
  }
  return null
}

let bucketVerified = false

/** @internal Reset bucket verification flag — for testing only */
export function _resetBucketVerified() {
  bucketVerified = false
}

/**
 * Ensure the 'documents' storage bucket exists, creating it if missing.
 * Runs once per process lifetime (same pattern as ensureInitialized).
 *
 * Uses a cookieless service-role client for bucket admin operations
 * (getBucket/createBucket require service-role). This avoids the cookie
 * dependency that hangs in API-key auth contexts (e.g. MCP server).
 */
async function ensureDocumentsBucket(): Promise<void> {
  if (bucketVerified) return

  const serviceClient = createServiceClientNoCookies()
  const { data: bucket } = await serviceClient.storage.getBucket('documents')

  if (!bucket) {
    await serviceClient.storage.createBucket('documents', {
      public: false,
      fileSizeLimit: 52428800, // 50 MB
    })
  }

  bucketVerified = true
}

/**
 * Compute SHA-256 hash of a file buffer
 */
export async function computeSHA256(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Upload a document and create a record with SHA-256 integrity hash
 */
export async function uploadDocument(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  file: { name: string; buffer: ArrayBuffer; type?: string },
  metadata: {
    upload_source?: DocumentUploadSource
    journal_entry_id?: string
    journal_entry_line_id?: string
  } = {}
): Promise<DocumentAttachment> {
  await ensureDocumentsBucket()

  // Reject corrupt uploads at the boundary — see validateDocumentMagicBytes.
  if (file.type) {
    const magicError = validateDocumentMagicBytes(file.buffer, file.type)
    if (magicError) throw new Error(magicError)
  }

  // Compute SHA-256 hash
  const sha256Hash = await computeSHA256(file.buffer)

  // Generate storage path
  const timestamp = Date.now()
  const storagePath = `documents/${userId}/${timestamp}_${sanitizeFileName(file.name)}`

  // Upload to Supabase Storage
  const { error: uploadError } = await supabase.storage
    .from('documents')
    .upload(storagePath, file.buffer, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    })

  if (uploadError) {
    throw new Error(`Failed to upload document: ${uploadError.message}`)
  }

  // Create document record
  const { data, error } = await supabase
    .from('document_attachments')
    .insert({
      user_id: userId,
      company_id: companyId,
      storage_path: storagePath,
      file_name: file.name,
      file_size_bytes: file.buffer.byteLength,
      mime_type: file.type || null,
      sha256_hash: sha256Hash,
      version: 1,
      is_current_version: true,
      uploaded_by: userId,
      upload_source: metadata.upload_source || 'file_upload',
      digitization_date: new Date().toISOString(),
      journal_entry_id: metadata.journal_entry_id || null,
      journal_entry_line_id: metadata.journal_entry_line_id || null,
    })
    .select()
    .single()

  if (error) {
    // Clean up uploaded file on record creation failure
    await supabase.storage.from('documents').remove([storagePath])
    throw new Error(`Failed to create document record: ${error.message}`)
  }

  const result = data as DocumentAttachment

  await eventBus.emit({
    type: 'document.uploaded',
    payload: { document: result, userId, companyId },
  })

  return result
}

/**
 * Create a new version of an existing document (WORM: old version is superseded)
 *
 * Uses the create_document_version RPC for atomic versioning with:
 * - Row-level locking (prevents concurrent versioning race condition)
 * - Cryptographic hash chain (prev_version_hash links to previous version)
 * - Single transaction (insert new + mark old superseded)
 */
export async function createNewVersion(
  supabase: SupabaseClient,
  userId: string,
  originalId: string,
  file: { name: string; buffer: ArrayBuffer; type?: string }
): Promise<DocumentAttachment> {
  await ensureDocumentsBucket()

  if (file.type) {
    const magicError = validateDocumentMagicBytes(file.buffer, file.type)
    if (magicError) throw new Error(magicError)
  }

  // Compute SHA-256 hash
  const sha256Hash = await computeSHA256(file.buffer)

  // Upload new file to Storage
  const timestamp = Date.now()
  const storagePath = `documents/${userId}/${timestamp}_${sanitizeFileName(file.name)}`

  const { error: uploadError } = await supabase.storage
    .from('documents')
    .upload(storagePath, file.buffer, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    })

  if (uploadError) {
    throw new Error(`Failed to upload new version: ${uploadError.message}`)
  }

  // Atomic version creation via RPC (row lock + hash chain + supersede in one tx)
  const { data: newDocId, error: rpcError } = await supabase.rpc('create_document_version', {
    p_user_id: userId,
    p_original_doc_id: originalId,
    p_storage_path: storagePath,
    p_file_name: file.name,
    p_file_size_bytes: file.buffer.byteLength,
    p_mime_type: file.type || null,
    p_sha256_hash: sha256Hash,
  })

  if (rpcError) {
    // Clean up uploaded file on RPC failure
    await supabase.storage.from('documents').remove([storagePath])
    throw new Error(`Failed to create new version: ${rpcError.message}`)
  }

  // Fetch the complete new version record
  const { data: newDoc, error: fetchError } = await supabase
    .from('document_attachments')
    .select('*')
    .eq('id', newDocId)
    .single()

  if (fetchError || !newDoc) {
    throw new Error('Failed to fetch new version record')
  }

  return newDoc as DocumentAttachment
}

/**
 * Link an existing document to a journal entry
 */
export async function linkToJournalEntry(
  supabase: SupabaseClient,
  companyId: string,
  documentId: string,
  journalEntryId: string,
  journalEntryLineId?: string
): Promise<DocumentAttachment> {

  const { data, error } = await supabase
    .from('document_attachments')
    .update({
      journal_entry_id: journalEntryId,
      journal_entry_line_id: journalEntryLineId || null,
    })
    .eq('id', documentId)
    .eq('company_id', companyId)
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to link document: ${error.message}`)
  }

  return data as DocumentAttachment
}

export type DeleteDocumentResult =
  | { ok: true; document: Pick<DocumentAttachment, 'id' | 'file_name'> }
  | { ok: false; reason: 'not_found' | 'linked_to_entry'; status: number; message: string }

/**
 * Delete a document if and only if it is not yet linked to a journal entry.
 *
 * BFL 7 kap 2§: once a document is attached to a verifikation it becomes
 * räkenskapsinformation and may not be deleted within the 7-year retention
 * window. Linked docs must be superseded via createNewVersion() instead.
 * The block_document_deletion() trigger is the DB-level backstop.
 */
export async function deleteDocument(
  supabase: SupabaseClient,
  companyId: string,
  documentId: string
): Promise<DeleteDocumentResult> {
  const { data: doc, error: fetchError } = await supabase
    .from('document_attachments')
    .select('id, file_name, storage_path, journal_entry_id, user_id')
    .eq('id', documentId)
    .eq('company_id', companyId)
    .maybeSingle()

  if (fetchError || !doc) {
    return {
      ok: false,
      reason: 'not_found',
      status: 404,
      message: 'Underlaget hittades inte.',
    }
  }

  if (doc.journal_entry_id) {
    return {
      ok: false,
      reason: 'linked_to_entry',
      status: 409,
      message:
        'Underlaget är knutet till en verifikation och utgör räkenskapsinformation enligt Bokföringslagen 7 kap 2§. Räkenskapsinformation ska bevaras i minst 7 år och får inte raderas. Använd "Ersätt med ny version" om underlaget behöver korrigeras.',
    }
  }

  const { error: deleteError } = await supabase
    .from('document_attachments')
    .delete()
    .eq('id', documentId)
    .eq('company_id', companyId)

  if (deleteError) {
    const msg = (deleteError as { message?: string }).message ?? ''
    if (msg.includes('Bokföringslagen') || msg.includes('retention')) {
      return {
        ok: false,
        reason: 'linked_to_entry',
        status: 409,
        message:
          'Underlaget kan inte tas bort på grund av Bokföringslagens bevarandekrav (7 kap 2§).',
      }
    }
    throw new Error(`Failed to delete document: ${msg}`)
  }

  if (doc.storage_path) {
    await supabase.storage.from('documents').remove([doc.storage_path])
  }

  await eventBus.emit({
    type: 'document.deleted',
    payload: {
      document: { id: doc.id, file_name: doc.file_name },
      userId: doc.user_id,
      companyId,
    },
  })

  return { ok: true, document: { id: doc.id, file_name: doc.file_name } }
}

/**
 * Verify document integrity by re-hashing and comparing
 */
export async function verifyIntegrity(
  supabase: SupabaseClient,
  companyId: string,
  documentId: string
): Promise<{ valid: boolean; storedHash: string; computedHash: string }> {

  // Fetch document record
  const { data: doc, error: docError } = await supabase
    .from('document_attachments')
    .select('storage_path, sha256_hash')
    .eq('id', documentId)
    .eq('company_id', companyId)
    .single()

  if (docError || !doc) {
    throw new Error('Document not found')
  }

  // Download file from storage
  const { data: fileData, error: downloadError } = await supabase.storage
    .from('documents')
    .download(doc.storage_path)

  if (downloadError || !fileData) {
    throw new Error(`Failed to download document: ${downloadError?.message}`)
  }

  // Re-compute hash
  const buffer = await fileData.arrayBuffer()
  const computedHash = await computeSHA256(buffer)

  return {
    valid: computedHash === doc.sha256_hash,
    storedHash: doc.sha256_hash,
    computedHash,
  }
}
