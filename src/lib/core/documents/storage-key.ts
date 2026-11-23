import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Which storage keys the service role follows for a row of a company.
 *
 * A row's key is read, signed or removed with the service role only when it
 * lies inside the row's own company:
 *
 *   documents/{companyId}/...   the company's folder, every upload since
 *                               20260726092000
 *   documents/{userId}/{file}   the legacy uploader layout, one folder deep,
 *                               for a document row only
 *
 * A legacy key names no company; the database places it: a document row
 * written with a member's own token takes a key under the company's folder, or
 * one another row of the same company already holds
 * (guard_document_storage_path, migration 20261123092000). The SQL repeats the
 * folder rule there and in create_document_version.
 *
 * Never followed: a key outside the documents/ root; a key with an empty, "."
 * or ".." part; and a key holding a control character, \, %, ? or #. Storage
 * builds its request URL from the key as written, so a key is followed only in
 * the plain form uploads give it.
 *
 * This module imports nothing from the app, so lib/documents/preview.ts can
 * use it; document-service.ts re-exports it.
 */

const DOCUMENTS_BUCKET = 'documents'
const DOCUMENTS_ROOT = 'documents'
const UNSAFE_KEY_CHARACTER = /[\u0000-\u001f\u007f\\%?#]/

/**
 * True when a key, in any bucket, is in the plain form uploads give it: no
 * empty, "." or ".." part and no control character, \, %, ? or #. Storage
 * builds its request URL from the key as written, so only a plain key names
 * the object it appears to name.
 */
export function isPlainStorageKey(storagePath: string | null | undefined): storagePath is string {
  if (!storagePath || UNSAFE_KEY_CHARACTER.test(storagePath)) return false
  return !storagePath.split('/').some((part) => part === '' || part === '.' || part === '..')
}

/** The key's parts when it is a plain key under the documents/ root, else null. */
function documentKeyParts(storagePath: string | null | undefined): string[] | null {
  if (!isPlainStorageKey(storagePath)) return null
  const parts = storagePath.split('/')
  return parts[0] === DOCUMENTS_ROOT ? parts : null
}

/** A company id as it appears in a key: ids are UUIDs, and a caller may write one in capitals. */
const sameCompany = (segment: string | undefined, companyId: string): boolean =>
  segment !== undefined && segment.toLowerCase() === companyId.toLowerCase()

/** True when the key lies in the company's own folder, documents/{companyId}/... */
export function isCompanyFolderDocumentKey(
  storagePath: string | null | undefined,
  companyId: string | null | undefined
): boolean {
  const parts = documentKeyParts(storagePath)
  return !!parts && !!companyId && sameCompany(parts[1], companyId) && parts.length >= 3
}

/** True when the service role may follow this key for a document row of this company: its folder, or a legacy key. */
export function isDocumentKeyOfCompany(
  storagePath: string | null | undefined,
  companyId: string | null | undefined
): boolean {
  const parts = documentKeyParts(storagePath)
  if (!parts || !companyId) return false
  return sameCompany(parts[1], companyId) ? parts.length >= 3 : parts.length === 3
}

/**
 * Every key that could hold the bytes of a document row, the stored pointer
 * first; empty when the pointer is not the company's. A legacy pointer adds its
 * company-scoped copy, where the Phase B backfill
 * (scripts/backfill-document-storage-paths.ts) puts the object before it
 * repoints the row. No candidate is derived by taking a folder off a key: the
 * remainder of a company-scoped key is not the company's own.
 */
export function documentStoragePathCandidates(
  storagePath: string,
  companyId: string | null | undefined
): string[] {
  if (!companyId || !isDocumentKeyOfCompany(storagePath, companyId)) return []
  const parts = storagePath.split('/')
  if (sameCompany(parts[1], companyId)) return [storagePath]
  return [storagePath, [DOCUMENTS_ROOT, companyId.toLowerCase(), ...parts.slice(1)].join('/')]
}

/**
 * The legacy key a company-scoped key was copied from, for a row the Phase B
 * backfill repointed: documents/{companyId}/{userId}/{file} came from
 * documents/{userId}/{file}, the uploader being the row's user. Null for any
 * other key. Only for cleaning up after an erased row, and only when no row
 * still names the key (deleteDocument).
 */
export function legacySourceOfDocumentKey(
  storagePath: string,
  companyId: string,
  userId: string | null | undefined
): string | null {
  const parts = documentKeyParts(storagePath)
  if (!parts || !userId || parts.length !== 4 || !sameCompany(parts[1], companyId) || parts[2] !== userId) return null
  return [DOCUMENTS_ROOT, userId, parts[3]].join('/')
}

type StorageErrorLike = { message?: string; status?: number } | null

/** The answer for a key the service role does not follow: a 403, never a "not found". */
function keyOutsideCompany(): { message: string; status: number } {
  return { message: 'storage key is not inside the document company', status: 403 }
}

/**
 * Download a document object, tolerating both key layouts.
 *
 * Returns the resolved key alongside the blob so callers can log or repair
 * a stale `document_attachments.storage_path` pointer. When every candidate
 * fails, the FIRST error is returned: it refers to the stored pointer, which
 * is the actionable one. `errors` holds every candidate's error, in order:
 * a caller that concludes the object is gone (the integrity check) needs
 * every key to have answered "not found", not only the first. A key outside
 * the company is not fetched at all and answers with a 403.
 */
export async function downloadDocumentObject(
  supabase: SupabaseClient,
  storagePath: string,
  companyId: string | null | undefined
): Promise<{ blob: Blob | null; error: StorageErrorLike; errors: NonNullable<StorageErrorLike>[]; resolvedPath: string | null }> {
  const candidates = documentStoragePathCandidates(storagePath, companyId)
  if (candidates.length === 0) {
    const refusal = keyOutsideCompany()
    return { blob: null, error: refusal, errors: [refusal], resolvedPath: null }
  }
  const errors: NonNullable<StorageErrorLike>[] = []
  for (const candidate of candidates) {
    const { data, error } = await supabase.storage.from(DOCUMENTS_BUCKET).download(candidate)
    if (!error && data) {
      return { blob: data as Blob, error: null, errors: [], resolvedPath: candidate }
    }
    errors.push((error as StorageErrorLike) ?? { message: 'download returned no data' })
  }
  return { blob: null, error: errors[0] ?? null, errors, resolvedPath: null }
}

/**
 * True when a row that names its file by bucket and key names one in the
 * company's own folder of the documents bucket: the only place such rows (the
 * reconciliation attachments) keep their files.
 */
export function isCompanyFolderObject(bucket: string, storagePath: string, companyId: string): boolean {
  return bucket === DOCUMENTS_BUCKET && isCompanyFolderDocumentKey(storagePath, companyId)
}

/**
 * Download the object a row names by bucket and key, for rows whose files only
 * ever live in the company's own folder of the documents bucket (the
 * reconciliation attachments): any other bucket, a legacy key or a key outside
 * the company answers with a 403 and nothing is fetched.
 */
export async function downloadCompanyFolderObject(
  supabase: SupabaseClient,
  bucket: string,
  storagePath: string,
  companyId: string
): ReturnType<typeof downloadDocumentObject> {
  if (!isCompanyFolderObject(bucket, storagePath, companyId)) {
    const refusal = keyOutsideCompany()
    return { blob: null, error: refusal, errors: [refusal], resolvedPath: null }
  }
  return downloadDocumentObject(supabase, storagePath, companyId)
}

/** A signed URL for a document object, only for a key inside the company (createSignedUrl's answer otherwise). */
export async function signDocumentObject(
  supabase: SupabaseClient,
  storagePath: string,
  companyId: string,
  expiresIn: number,
  options?: { download?: string | boolean }
): Promise<{ data: { signedUrl: string } | null; error: { message: string; status?: number } | null }> {
  if (!isDocumentKeyOfCompany(storagePath, companyId)) return { data: null, error: keyOutsideCompany() }
  const bucket = supabase.storage.from(DOCUMENTS_BUCKET)
  return options ? bucket.createSignedUrl(storagePath, expiresIn, options) : bucket.createSignedUrl(storagePath, expiresIn)
}
