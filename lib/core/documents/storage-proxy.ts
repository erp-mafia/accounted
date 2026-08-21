/**
 * Same-origin proxy for Supabase Storage signed URLs.
 *
 * Agent sandboxes (Claude Desktop's code execution, some MCP clients) only
 * allow network egress to the host the MCP server lives on. Our signed
 * Storage URLs point at <project>.supabase.co, so a model-free upload or a
 * document download from such a sandbox was refused before it left the box
 * (user report 2026-08-21). These helpers rewrite a signed URL onto this
 * app's own origin (`/api/storage/...`) and resolve it back to the upstream
 * Storage URL inside the proxy route.
 *
 * The signed token travels unchanged and is the only credential on both
 * sides: the proxy grants nothing the public Storage host did not already
 * grant, and it refuses every path that is not a signed object path on the
 * documents bucket. Without NEXT_PUBLIC_APP_URL (a self-host that never set
 * it) the rewrite is a no-op rather than a broken localhost link.
 */

export const STORAGE_PROXY_ROUTE = '/api/storage'

/** Upstream prefix under the Storage API that every signed object URL shares. */
const UPSTREAM_OBJECT_PREFIX = '/storage/v1/object/'

/**
 * Only token-authenticated object paths on the documents bucket: signed
 * downloads (`sign/documents/...`) and signed uploads
 * (`upload/sign/documents/...`). Anything else (public objects, bucket
 * admin, other buckets) is not this proxy's business.
 */
const ALLOWED_OBJECT_PATH_RE = /^(sign|upload\/sign)\/documents\/[^/]+/

export type StorageProxyResolution =
  | { ok: true; url: string }
  | { ok: false; reason: 'unsupported_path' | 'missing_token' | 'storage_unconfigured' }

/**
 * True when every segment of the (still percent-encoded) object path is a
 * plain name: no empty segment, no `.`/`..` in raw or percent-encoded form
 * (`%2e%2e`, `.%2e`, `%2e.`: the WHATWG URL parser normalises those away,
 * which would let `sign/documents/%2e%2e/other/x` leave the documents
 * bucket), no backslash (a path separator for https URLs), no malformed
 * escapes.
 */
function hasOnlyPlainSegments(objectPath: string): boolean {
  for (const segment of objectPath.split('/')) {
    if (segment === '') return false
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return false
    }
    if (decoded === '.' || decoded === '..') return false
    if (decoded.includes('\\') || decoded.includes('/')) return false
  }
  return true
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function upstreamStorageOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  if (!raw) return null
  try {
    return new URL(raw).origin
  } catch {
    return null
  }
}

/**
 * Rewrite a Supabase signed Storage URL onto this app's origin. Returns the
 * input unchanged when it is not a signed documents-bucket URL on our Storage
 * host, or when the app has no public URL configured.
 */
export function toSameOriginStorageUrl(
  signedUrl: string,
  appBaseUrl: string | undefined = process.env.NEXT_PUBLIC_APP_URL,
): string {
  const base = appBaseUrl?.trim()
  const upstream = upstreamStorageOrigin()
  if (!base || !upstream) return signedUrl

  let url: URL
  try {
    url = new URL(signedUrl)
  } catch {
    return signedUrl
  }
  if (url.origin !== upstream) return signedUrl
  if (!url.pathname.startsWith(UPSTREAM_OBJECT_PREFIX)) return signedUrl

  // Keep the pathname exactly as Storage encoded it: object keys may hold
  // spaces and non-ASCII, and the token was signed over the real key.
  const objectPath = url.pathname.slice(UPSTREAM_OBJECT_PREFIX.length)
  if (!ALLOWED_OBJECT_PATH_RE.test(objectPath)) return signedUrl
  if (!url.searchParams.has('token')) return signedUrl

  return `${trimTrailingSlash(base)}${STORAGE_PROXY_ROUTE}/${objectPath}${url.search}`
}

/**
 * Resolve the proxied path (everything after `/api/storage/`, still
 * percent-encoded as received) plus its query back to the upstream Storage
 * URL. Fails closed on anything outside the signed documents-bucket paths.
 */
export function resolveUpstreamStorageUrl(
  objectPath: string,
  search: URLSearchParams,
): StorageProxyResolution {
  const upstream = upstreamStorageOrigin()
  if (!upstream) return { ok: false, reason: 'storage_unconfigured' }
  if (!ALLOWED_OBJECT_PATH_RE.test(objectPath) || !hasOnlyPlainSegments(objectPath)) {
    return { ok: false, reason: 'unsupported_path' }
  }
  if (!search.get('token')) return { ok: false, reason: 'missing_token' }

  const query = search.toString()
  const url = `${upstream}${UPSTREAM_OBJECT_PREFIX}${objectPath}${query ? `?${query}` : ''}`
  // Belt and braces: whatever fetch() will actually request, after URL
  // normalisation, must still sit inside the allowlist.
  let normalisedPath: string
  try {
    normalisedPath = new URL(url).pathname
  } catch {
    return { ok: false, reason: 'unsupported_path' }
  }
  if (
    !normalisedPath.startsWith(UPSTREAM_OBJECT_PREFIX) ||
    !ALLOWED_OBJECT_PATH_RE.test(normalisedPath.slice(UPSTREAM_OBJECT_PREFIX.length))
  ) {
    return { ok: false, reason: 'unsupported_path' }
  }

  return { ok: true, url }
}

/**
 * Read a request body into memory, aborting as soon as it exceeds `maxBytes`
 * instead of buffering an unbounded payload first and measuring afterwards
 * (the proxy is unauthenticated until Storage checks the token, so a
 * self-host without a platform body limit must not be forced to hold an
 * arbitrary upload in RAM). Returns null when the cap is exceeded.
 */
export async function readBodyWithCap(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<ArrayBuffer | null> {
  if (!body) return new ArrayBuffer(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out.buffer
}
