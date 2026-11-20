/**
 * Bank file imports as arrivals: the statement kept as it came, and one
 * arrival per import that entered the books.
 *
 * The dashboard reads a file in two requests. Parse receives the file and
 * returns rows; execute receives those rows as JSON and never sees the file
 * again (sending it twice would put a second copy of every file against the
 * hosting gateway's 4.5 MB body limit). So the original is archived at
 * parse, under a key derived from the file's content hash (the same
 * file_hash that identifies the import in bank_file_imports): previewing a
 * file again, or going back and forth in the wizard, reuses one object. The
 * arrival itself is recorded at execute, when the rows actually entered,
 * and points at that object. The v1 import receives the file and imports it
 * in one request, so it archives and records together.
 *
 * Key: documents/{companyId}/arrivals/bank_file/{file_hash}/{file name}, in
 * the documents bucket: company-scoped policies, no UPDATE and no DELETE
 * (BFL 7 kap), like every other arrival original.
 *
 * No arrival_outputs per row: every inserted transaction already carries
 * bank_file_import_id, which is this arrival's source_ref.
 *
 * Best effort throughout: nothing here throws, and a failure never fails
 * the parse or the import.
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DOCUMENTS_BUCKET,
  recordArrival,
  safeArrivalFileName,
  type ArrivalActor,
  type ArrivalOriginalRef,
} from '@/lib/intake/arrivals'
import { createLogger } from '@/lib/logger'

const log = createLogger('import/bank-file/arrival')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256_RE = /^[0-9a-f]{64}$/

/** The storage key of a bank file's original, or null for an id or hash that cannot name one. */
export function bankFileOriginalPath(companyId: string, fileHash: string, filename: string): string | null {
  if (!UUID_RE.test(companyId ?? '') || !SHA256_RE.test(fileHash ?? '')) return null
  return `documents/${companyId}/arrivals/bank_file/${fileHash}/${safeArrivalFileName(filename || 'bankfil')}`
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** What is actually stored at `path`: the hash, size and type of those bytes. */
async function describeStoredOriginal(supabase: SupabaseClient, path: string): Promise<ArrivalOriginalRef | null> {
  const { data, error } = await supabase.storage.from(DOCUMENTS_BUCKET).download(path)
  if (error || !data) return null
  const bytes = new Uint8Array(await data.arrayBuffer())
  return { path, sha256: sha256Hex(bytes), size: bytes.byteLength, mime: data.type || null }
}

/**
 * Keep a bank file as it came. A second upload of the same file finds the
 * first object (no overwrite: the bucket is WORM) and describes that one.
 * Returns where it is, or null (logged) when it could not be kept.
 */
export async function archiveBankFileOriginal(
  supabase: SupabaseClient,
  params: { companyId: string; fileHash: string; filename: string; bytes: ArrayBuffer | Uint8Array; mime?: string | null },
): Promise<ArrivalOriginalRef | null> {
  const path = bankFileOriginalPath(params.companyId, params.fileHash, params.filename)
  if (!path) return null
  try {
    const bytes = params.bytes instanceof Uint8Array ? params.bytes : new Uint8Array(params.bytes)
    const mime = params.mime || 'application/octet-stream'
    const { error } = await supabase.storage.from(DOCUMENTS_BUCKET).upload(path, bytes, { contentType: mime, upsert: false })
    if (!error) return { path, sha256: sha256Hex(bytes), size: bytes.byteLength, mime }
    // Most often an earlier preview of the same file already stored it.
    const stored = await describeStoredOriginal(supabase, path)
    if (!stored) log.warn('bank file original could not be archived', { companyId: params.companyId, reason: error.message })
    return stored
  } catch (err) {
    log.warn('bank file original archive threw', {
      companyId: params.companyId,
      reason: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Record the arrival of one bank file import. `original` is the archive the
 * caller just made; without it the object stored at parse is read back. A
 * file whose original is missing still gets its arrival, marked as such.
 */
export async function recordBankFileArrival(
  supabase: SupabaseClient,
  params: {
    companyId: string
    importId: string
    fileHash: string
    filename: string
    format: string
    transactionCount: number
    importedCount: number
    dateFrom: string | null
    dateTo: string | null
    fetchedBy: ArrivalActor
    via: 'app' | 'partner_api'
    original?: ArrivalOriginalRef | null
  },
): Promise<void> {
  try {
    let original = params.original ?? null
    if (!original) {
      const path = bankFileOriginalPath(params.companyId, params.fileHash, params.filename)
      original = path ? await describeStoredOriginal(supabase, path) : null
    }
    await recordArrival(supabase, {
      companyId: params.companyId,
      source: 'bank_file',
      sourceRef: params.importId,
      receivedAt: new Date(),
      fetchedBy: params.fetchedBy,
      sourceMeta: {
        via: params.via,
        bank_file_import_id: params.importId,
        filename: params.filename,
        file_hash: params.fileHash,
        format: params.format,
        transaction_count: params.transactionCount,
        imported_count: params.importedCount,
        date_from: params.dateFrom,
        date_to: params.dateTo,
        ...(original ? {} : { original_missing: 'not_archived' }),
      },
      originalRef: original ?? undefined,
    })
  } catch (err) {
    log.warn('bank file arrival could not be recorded', {
      companyId: params.companyId,
      entityId: params.importId,
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}
