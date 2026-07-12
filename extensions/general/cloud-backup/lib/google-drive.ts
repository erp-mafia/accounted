/**
 * Minimal Google Drive v3 client: just enough to:
 *   - find or create a named folder,
 *   - revalidate a cached file/folder id,
 *   - upload a file (create) or update one in place, via resumable uploads.
 *
 * We operate on `drive.file` scope, so we can only see files we created.
 * Queries by name return only app-created folders with that name.
 *
 * Uploads use Drive's resumable protocol in 8 MB chunks (a multiple of the
 * required 256 KiB): no multipart body concatenation (which doubles memory
 * for large archives), per-chunk retries on transient failures, and every
 * upload is verified against the md5Checksum Drive reports. A silently
 * corrupted backup is worse than a failed one.
 */

import { createHash } from 'node:crypto'

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files'
const FOLDER_MIME = 'application/vnd.google-apps.folder'

/** 8 MB: resumable chunks must be multiples of 256 KiB. */
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024
const CHUNK_MAX_ATTEMPTS = 3
const RESULT_FIELDS = 'id,name,size,webViewLink,md5Checksum'

interface DriveFile {
  id: string
  name: string
}

/** Thrown when an update targets a file that no longer exists (404). */
export class DriveFileGoneError extends Error {
  constructor(fileId: string) {
    super(`Drive file ${fileId} no longer exists`)
    this.name = 'DriveFileGoneError'
  }
}

async function driveFetch(
  accessToken: string,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const res = await fetch(`${DRIVE_API}${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      Authorization: `Bearer ${accessToken}`,
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Drive API ${res.status}: ${body.slice(0, 200)}`)
  }
  return res
}

/**
 * Find a folder by name under a parent (or root). Returns null if none exists.
 * Uses q= filter; drive.file scope only sees app-created folders.
 */
async function findFolderByName(
  accessToken: string,
  name: string,
  parentId: string | null
): Promise<DriveFile | null> {
  const parentClause = parentId ? `'${parentId}' in parents` : `'root' in parents`
  const q = [
    `mimeType = '${FOLDER_MIME}'`,
    `name = '${escapeName(name)}'`,
    parentClause,
    'trashed = false',
  ].join(' and ')
  const url = `/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`
  const res = await driveFetch(accessToken, url)
  const json = (await res.json()) as { files: DriveFile[] }
  return json.files[0] || null
}

async function createFolder(
  accessToken: string,
  name: string,
  parentId: string | null
): Promise<DriveFile> {
  const body = {
    name,
    mimeType: FOLDER_MIME,
    parents: parentId ? [parentId] : undefined,
  }
  const res = await driveFetch(accessToken, '/files?fields=id,name', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as DriveFile
}

export async function ensureFolder(
  accessToken: string,
  name: string,
  parentId: string | null
): Promise<DriveFile> {
  const existing = await findFolderByName(accessToken, name, parentId)
  if (existing) return existing
  return createFolder(accessToken, name, parentId)
}

export interface FileMeta {
  id: string
  name: string
  /** True also when the file sits inside a trashed parent folder. */
  trashed: boolean
}

/**
 * Fetch metadata for a file/folder by id. Returns null on 404 (deleted or
 * never visible to this scope). Used to revalidate cached folder ids: a file
 * created inside a trashed folder is purged with it, so uploads must never
 * target a trashed parent.
 */
export async function getFileMeta(
  accessToken: string,
  fileId: string
): Promise<FileMeta | null> {
  const res = await fetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,trashed`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (res.status === 404) return null
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Drive API ${res.status}: ${body.slice(0, 200)}`)
  }
  const json = (await res.json()) as { id: string; name: string; trashed?: boolean }
  return { id: json.id, name: json.name, trashed: json.trashed === true }
}

export interface UploadResult {
  id: string
  name: string
  size_bytes: number
  web_view_link: string
  /** MD5 reported by Drive; present when the API returned it. */
  md5_checksum?: string
}

/**
 * Create a new file in a folder (resumable, md5-verified, one full retry on
 * checksum mismatch).
 */
export async function uploadFile(
  accessToken: string,
  folderId: string,
  fileName: string,
  data: ArrayBuffer,
  contentType = 'application/zip'
): Promise<UploadResult> {
  return verifiedUpload(data, () =>
    resumableUpload(accessToken, data, contentType, {
      method: 'POST',
      url: `${DRIVE_UPLOAD_API}?uploadType=resumable&fields=${RESULT_FIELDS}`,
      metadata: { name: fileName, parents: [folderId] },
    })
  )
}

/**
 * Replace the content of an existing file in place (resumable, md5-verified).
 * Drive keeps prior versions of updated files for ~30 days, which gives the
 * backup rolling history without accumulating one file per day.
 * Throws DriveFileGoneError when the file id no longer exists.
 */
export async function updateFile(
  accessToken: string,
  fileId: string,
  data: ArrayBuffer,
  contentType = 'application/zip'
): Promise<UploadResult> {
  return verifiedUpload(data, () =>
    resumableUpload(accessToken, data, contentType, {
      method: 'PATCH',
      url: `${DRIVE_UPLOAD_API}/${encodeURIComponent(fileId)}?uploadType=resumable&fields=${RESULT_FIELDS}`,
      fileId,
    })
  )
}

async function verifiedUpload(
  data: ArrayBuffer,
  run: () => Promise<UploadResult>
): Promise<UploadResult> {
  const expectedMd5 = createHash('md5').update(Buffer.from(data)).digest('hex')
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await run()
    if (!result.md5_checksum || result.md5_checksum === expectedMd5) {
      return result
    }
    lastError = new Error(
      `Drive upload checksum mismatch: expected ${expectedMd5}, got ${result.md5_checksum}`
    )
  }
  throw lastError
}

interface ResumableTarget {
  method: 'POST' | 'PATCH'
  url: string
  metadata?: Record<string, unknown>
  fileId?: string
}

async function resumableUpload(
  accessToken: string,
  data: ArrayBuffer,
  contentType: string,
  target: ResumableTarget
): Promise<UploadResult> {
  // 1) Initiate the session. Metadata (name/parents) rides on the initiation
  //    request; the byte chunks follow against the returned session URL.
  const initRes = await fetch(target.url, {
    method: target.method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': contentType,
      'X-Upload-Content-Length': String(data.byteLength),
    },
    body: target.metadata ? JSON.stringify(target.metadata) : undefined,
  })
  if (initRes.status === 404 && target.fileId) {
    throw new DriveFileGoneError(target.fileId)
  }
  if (!initRes.ok) {
    const body = await initRes.text()
    throw new Error(`Drive upload init failed: ${initRes.status} ${body.slice(0, 200)}`)
  }
  const sessionUrl = initRes.headers.get('location')
  if (!sessionUrl) {
    throw new Error('Drive upload init returned no session URL')
  }

  // 2) Send the bytes in chunks. 308 = chunk accepted, keep going;
  //    200/201 = upload complete with the file resource as body.
  const total = data.byteLength
  const buffer = Buffer.from(data)
  let offset = 0
  while (true) {
    const end = Math.min(offset + UPLOAD_CHUNK_BYTES, total)
    const chunk = buffer.subarray(offset, end)

    let res: Response | null = null
    let lastErr: unknown = null
    for (let attempt = 0; attempt < CHUNK_MAX_ATTEMPTS; attempt++) {
      try {
        res = await fetch(sessionUrl, {
          method: 'PUT',
          headers: {
            'Content-Length': String(chunk.length),
            'Content-Range': `bytes ${offset}-${end - 1}/${total}`,
          },
          body: chunk,
        })
        if (res.status >= 500) {
          lastErr = new Error(`Drive chunk upload ${res.status}`)
          res = null
          continue
        }
        break
      } catch (err) {
        lastErr = err
        res = null
      }
    }
    if (!res) {
      throw lastErr instanceof Error
        ? lastErr
        : new Error('Drive chunk upload failed after retries')
    }

    if (res.status === 308) {
      // Advance to wherever the session says it is (defensive: usually `end`).
      const range = res.headers.get('range')
      const match = range?.match(/bytes=0-(\d+)/)
      offset = match ? Number(match[1]) + 1 : end
      continue
    }
    if (res.ok) {
      const json = (await res.json()) as {
        id: string
        name: string
        size?: string
        webViewLink?: string
        md5Checksum?: string
      }
      return {
        id: json.id,
        name: json.name,
        size_bytes: json.size ? Number(json.size) : total,
        web_view_link:
          json.webViewLink || `https://drive.google.com/file/d/${json.id}/view`,
        md5_checksum: json.md5Checksum,
      }
    }
    const body = await res.text()
    throw new Error(`Drive upload failed: ${res.status} ${body.slice(0, 200)}`)
  }
}

function escapeName(name: string): string {
  // Drive query string: escape single quotes and backslashes.
  return name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}
