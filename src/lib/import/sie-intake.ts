import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SIE_LIMITS } from './sie-job-contract'
import { hasSIEFileExtension } from './sie-file-extensions'
import { SIEIntakeNotFoundError, SIEIntakePathError, SIEJobValidationError } from './sie-jobs'

const INVALID_INTAKE = 'Importens uppladdningslänk eller filnamn är ogiltigt.'

/** True only for `<companyId>/sie-intake/<36 hex or dash>.se`: no other segment, no `..`. */
export function isSIEIntakePath(companyId: string, path: string): boolean {
  const prefix = `${companyId}/sie-intake/`
  return path.startsWith(prefix) && /^[a-f0-9-]{36}\.se$/.test(path.slice(prefix.length))
}

export async function readSIEIntakeFile(supabase:SupabaseClient,companyId:string,path:string,filename:string):Promise<File> {
  if (!isSIEIntakePath(companyId, path)) throw new SIEIntakePathError(INVALID_INTAKE)
  if (!hasSIEFileExtension(filename) || filename.length > 255) throw new SIEJobValidationError(INVALID_INTAKE)
  const {data,error} = await supabase.storage.from('sie-files').download(path)
  if (error || !data) throw new SIEIntakeNotFoundError('Den uppladdade SIE-filen hittades inte.')
  if (!data.size || data.size > SIE_LIMITS.fileBytes) throw new SIEJobValidationError('SIE-filen måste vara mellan 1 byte och 50 MB.')
  return new File([data],filename,{type:'application/octet-stream'})
}

export async function readSIERequestFile(form:FormData,supabase:SupabaseClient,companyId:string):Promise<File|null> {
  if (typeof form.get('storagePath') === 'string') return readSIEIntakeFile(supabase,companyId,
    String(form.get('storagePath')),String(form.get('filename')))
  const file = form.get('file')
  return file instanceof File ? file : null
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/**
 * Storage kept failing to keep a file that was itself fine, and holds nothing
 * at its path. Transient: nothing was imported, so the same step can simply
 * run again (SIE_INTAKE_ARCHIVE_UNAVAILABLE).
 */
export class SIEArchiveUnavailableError extends Error {
  constructor() {
    super('SIE-filen kunde inte arkiveras.')
    this.name = 'SIEArchiveUnavailableError'
  }
}

/**
 * The waits before uploading again after storage stored nothing. Prod
 * (PH 193): one storage timeout (HTTP 544) on one of three uploads failed a
 * three-year provider migration whose fetch had worked.
 */
const ARCHIVE_RETRY_DELAYS_MS: readonly number[] = [300, 1200]

/**
 * Archive SIE text the server fetched itself (a provider migration) where a
 * browser upload puts its file, and return the path the import reads it back
 * from. The text then never crosses a request or response body, so the
 * hosting gateway's body limit (4.5 MB on Vercel) does not cap the import.
 *
 * The name is derived from the content's sha256: fetching the same export
 * again (back and forth in the wizard) reuses the object instead of adding a
 * copy to a bucket nothing deletes from (no DELETE policy, BFL 7 kap).
 */
export async function archiveSIEIntakeText(
  supabase: SupabaseClient,
  companyId: string,
  content: string,
  options: { retryDelaysMs?: readonly number[] } = {},
): Promise<{ path: string; bytes: number }> {
  const bytes = new TextEncoder().encode(content)
  if (!bytes.byteLength || bytes.byteLength > SIE_LIMITS.fileBytes) {
    throw new SIEJobValidationError('SIE-filen måste vara mellan 1 byte och 50 MB.')
  }
  const hash = sha256(bytes)
  const name = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
  const path = `${companyId}/sie-intake/${name}.se`
  const bucket = supabase.storage.from('sie-files')
  const blob = new Blob([bytes], { type: 'text/plain' })
  const retryDelaysMs = options.retryDelaysMs ?? ARCHIVE_RETRY_DELAYS_MS
  for (let attempt = 0; ; attempt++) {
    const { error } = await bucket.upload(path, blob, { upsert: false })
    if (!error) return { path, bytes: bytes.byteLength }
    const existing = await bucket.download(path)
    if (!existing.error && existing.data) {
      // Only an identical object already at this path is a safe reuse: the
      // same export fetched before, or this upload when storage kept it but
      // failed to answer. A different object is never overwritten, and no
      // retry can change it.
      if (sha256(new Uint8Array(await existing.data.arrayBuffer())) === hash) return { path, bytes: bytes.byteLength }
      throw new Error('SIE-filen kunde inte arkiveras.')
    }
    // Nothing stored: the upload itself failed. Try again before giving up.
    if (attempt >= retryDelaysMs.length) throw new SIEArchiveUnavailableError()
    await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]))
  }
}
