/**
 * Minimal Dropbox content client: just enough to write one archive into the
 * app folder and prove the stored bytes are the bytes we sent.
 *
 * Two upload paths, picked by size:
 *   - files/upload for anything that fits one chunk (one round trip),
 *   - files/upload_session/* in 8 MB chunks for the large archives, which
 *     avoids holding a second copy of the payload for a multipart body.
 *
 * Both write with `mode: overwrite`, which makes uploads idempotent and lets
 * Dropbox keep its own version history (30 days on Basic, longer on paid
 * plans): the same rolling-history property the Drive target relies on.
 * Dropbox creates missing parent folders on write, so there is no folder
 * bootstrap step and nothing to revalidate.
 *
 * Every upload is verified against the `content_hash` Dropbox reports. A
 * silently corrupted backup is worse than a failed one.
 */

import { createHash } from 'node:crypto'

const CONTENT_API = 'https://content.dropboxapi.com/2'

/** 8 MB upload chunks: comfortably inside Dropbox's 150 MB per-request cap. */
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024
const CHUNK_MAX_ATTEMPTS = 3

/** Dropbox's content_hash is defined over 4 MB blocks: not our chunk size. */
const CONTENT_HASH_BLOCK_BYTES = 4 * 1024 * 1024

export interface DropboxUploadResult {
  /** App-folder-relative path, used as the file handle in sync state. */
  path: string
  name: string
  size_bytes: number
  content_hash?: string
}

interface DropboxFileMetadata {
  name: string
  path_lower?: string
  path_display?: string
  size?: number
  content_hash?: string
}

/**
 * Dropbox's documented content hash: SHA-256 of the concatenated SHA-256
 * digests of each 4 MB block. Computing it locally is the only way to verify
 * an upload, since Dropbox reports this and no other checksum.
 */
export function dropboxContentHash(data: ArrayBuffer): string {
  const buffer = Buffer.from(data)
  const blockHashes: Buffer[] = []
  for (let offset = 0; offset < buffer.length; offset += CONTENT_HASH_BLOCK_BYTES) {
    const block = buffer.subarray(
      offset,
      Math.min(offset + CONTENT_HASH_BLOCK_BYTES, buffer.length)
    )
    blockHashes.push(createHash('sha256').update(block).digest())
  }
  // An empty file hashes the empty concatenation, which is what Dropbox reports.
  return createHash('sha256').update(Buffer.concat(blockHashes)).digest('hex')
}

/**
 * Dropbox passes call arguments in the `Dropbox-API-Arg` HTTP header, which
 * must be ASCII. Swedish file and folder names (`LÄSMIG.txt`, `Testbolag AB`)
 * would otherwise produce an invalid header and a 400: escape every non-ASCII
 * code unit as a \\uXXXX sequence, which Dropbox unescapes server-side.
 */
/** A single backslash, spelled without an escape the tooling can mangle. */
const BACKSLASH = String.fromCharCode(92)
const ESCAPE_PREFIX = BACKSLASH + 'u'

export function asciiJson(value: unknown): string {
  let out = ''
  // Iterate by code point so an astral character (an emoji in a company
  // name) is escaped as its two surrogate halves rather than mangled.
  for (const char of JSON.stringify(value)) {
    if (char.codePointAt(0)! < 128) {
      out += char
      continue
    }
    for (let i = 0; i < char.length; i++) {
      out += ESCAPE_PREFIX + char.charCodeAt(i).toString(16).padStart(4, '0')
    }
  }
  return out
}

/**
 * Dropbox rejects `/ \ : ? * " < > |` in a path component, along with control
 * characters and trailing dots or spaces. Company names are user-supplied, so
 * a name like `Bolaget AB / Filial` must not be able to produce an invalid
 * path (or escape into a sibling folder).
 */
export function sanitizeDropboxName(name: string): string {
  const ILLEGAL = '/:?*"<>|' + BACKSLASH
  let out = ''
  for (const char of name) {
    const code = char.codePointAt(0)!
    if (code < 0x20 || code === 0x7f) continue
    out += ILLEGAL.includes(char) ? '-' : char
  }
  const cleaned = out.trim().replace(/[. ]+$/, '').slice(0, 180)
  return cleaned || 'foretag'
}

async function readError(res: Response): Promise<string> {
  const body = await res.text().catch(() => '')
  return `${res.status} ${body.slice(0, 200)}`
}

/**
 * A response Dropbox will keep rejecting however many times we ask (bad path,
 * insufficient scope, dead token). Retrying it wastes the cron's time budget,
 * so it aborts the chunk loop immediately.
 */
class DropboxFatalError extends Error {}

/**
 * Upload `data` to `path`, replacing whatever is there.
 *
 * `path` is app-folder-relative and must start with `/`
 * (e.g. `/Testbolag AB (556000-0000)/Arkiv 2024.zip`).
 */
export async function uploadDropboxFile(
  accessToken: string,
  path: string,
  data: ArrayBuffer
): Promise<DropboxUploadResult> {
  const expected = dropboxContentHash(data)
  let lastError: Error | null = null

  // One full retry on a hash mismatch, mirroring the Drive target: a mismatch
  // is far more likely to be a truncated transfer than a corrupted source.
  for (let attempt = 0; attempt < 2; attempt++) {
    const meta =
      data.byteLength <= UPLOAD_CHUNK_BYTES
        ? await singleShotUpload(accessToken, path, data)
        : await sessionUpload(accessToken, path, data)

    const result: DropboxUploadResult = {
      path: meta.path_display || meta.path_lower || path,
      name: meta.name,
      size_bytes: typeof meta.size === 'number' ? meta.size : data.byteLength,
      content_hash: meta.content_hash,
    }
    if (!result.content_hash || result.content_hash === expected) {
      return result
    }
    lastError = new Error(
      `Dropbox upload checksum mismatch: expected ${expected}, got ${result.content_hash}`
    )
  }
  throw lastError
}

function commitArg(path: string) {
  return {
    path,
    mode: 'overwrite' as const,
    // No desktop notification for an automated nightly backup.
    mute: true,
    // Never let Dropbox invent `Arkiv 2024 (1).zip`: overwrite is the contract
    // the fingerprint logic depends on.
    autorename: false,
  }
}

async function singleShotUpload(
  accessToken: string,
  path: string,
  data: ArrayBuffer
): Promise<DropboxFileMetadata> {
  const res = await contentFetch(accessToken, '/files/upload', commitArg(path), data)
  return (await res.json()) as DropboxFileMetadata
}

/**
 * Chunked upload session. Transient failures are retried per chunk; the
 * session itself is not resumed across a failed run, because `performSync`
 * already persists per-file progress and simply re-uploads this one file.
 */
async function sessionUpload(
  accessToken: string,
  path: string,
  data: ArrayBuffer
): Promise<DropboxFileMetadata> {
  const total = data.byteLength

  // Chunks are sliced off the source rather than viewed into it: a view would
  // keep the whole 300 MB archive reachable from every in-flight request body.
  const firstChunk = data.slice(0, UPLOAD_CHUNK_BYTES)
  const startRes = await contentFetch(
    accessToken,
    '/files/upload_session/start',
    { close: false },
    firstChunk
  )
  const { session_id: sessionId } = (await startRes.json()) as { session_id: string }
  let offset = firstChunk.byteLength

  while (offset < total) {
    const end = Math.min(offset + UPLOAD_CHUNK_BYTES, total)
    const chunk = data.slice(offset, end)

    if (end >= total) {
      const finishRes = await contentFetch(
        accessToken,
        '/files/upload_session/finish',
        { cursor: { session_id: sessionId, offset }, commit: commitArg(path) },
        chunk
      )
      return (await finishRes.json()) as DropboxFileMetadata
    }

    await contentFetch(
      accessToken,
      '/files/upload_session/append_v2',
      { cursor: { session_id: sessionId, offset }, close: false },
      chunk
    )
    offset = end
  }

  // Payload was an exact multiple of the chunk size: close with an empty commit.
  const finishRes = await contentFetch(
    accessToken,
    '/files/upload_session/finish',
    { cursor: { session_id: sessionId, offset }, commit: commitArg(path) },
    new ArrayBuffer(0)
  )
  return (await finishRes.json()) as DropboxFileMetadata
}

async function contentFetch(
  accessToken: string,
  endpoint: string,
  arg: unknown,
  body: ArrayBuffer
): Promise<Response> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt < CHUNK_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${CONTENT_API}${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Dropbox-API-Arg': asciiJson(arg),
          'Content-Type': 'application/octet-stream',
        },
        body,
      })
      if (res.ok) return res
      // 429 (rate limited) and 5xx are the documented retryable responses;
      // everything else is our fault and will fail identically on retry.
      const detail = `Dropbox ${endpoint} failed: ${await readError(res)}`
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(detail)
        continue
      }
      throw new DropboxFatalError(detail)
    } catch (err) {
      if (err instanceof DropboxFatalError) throw err
      lastErr = err
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`Dropbox ${endpoint} failed after retries`)
}
