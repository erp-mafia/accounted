/**
 * Minimal Google Drive v3 client: just enough to:
 *   - find or create a named folder,
 *   - upload a file via multipart.
 *
 * We operate on `drive.file` scope, so we can only see files we created.
 * Queries by name return only app-created folders with that name.
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files'
const FOLDER_MIME = 'application/vnd.google-apps.folder'

interface DriveFile {
  id: string
  name: string
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

export interface UploadResult {
  id: string
  name: string
  size_bytes: number
  web_view_link: string
}

/**
 * Multipart upload: metadata + bytes in one request. Suitable for files
 * up to ~100 MB; beyond that Drive recommends resumable uploads.
 */
export async function uploadFile(
  accessToken: string,
  folderId: string,
  fileName: string,
  data: ArrayBuffer,
  contentType = 'application/zip'
): Promise<UploadResult> {
  const boundary = `gnubok-${crypto.randomUUID().replace(/-/g, '')}`
  const metadata = JSON.stringify({
    name: fileName,
    parents: [folderId],
  })

  const head =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`
  const tail = `\r\n--${boundary}--`

  const body = Buffer.concat([
    Buffer.from(head, 'utf8'),
    Buffer.from(data),
    Buffer.from(tail, 'utf8'),
  ])

  const res = await fetch(
    `${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id,name,size,webViewLink`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    }
  )

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Drive upload failed: ${res.status} ${errText.slice(0, 200)}`)
  }

  const json = (await res.json()) as {
    id: string
    name: string
    size?: string
    webViewLink?: string
  }

  return {
    id: json.id,
    name: json.name,
    size_bytes: json.size ? Number(json.size) : data.byteLength,
    web_view_link: json.webViewLink || `https://drive.google.com/file/d/${json.id}/view`,
  }
}

function escapeName(name: string): string {
  // Drive query string: escape single quotes and backslashes.
  return name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}
