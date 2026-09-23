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

/**
 * Content types a browser renders natively without a script context: PDF
 * and the raster image formats the document archive accepts. These are the
 * only types either document-serving route (the inline preview proxy and the
 * signed-URL proxy below) hands to the browser as-is. Everything else that
 * can reach the archive (text/html mail bodies, application/xhtml+xml
 * iXBRL, Peppol application/xml and text/xml, image/svg+xml, application/json,
 * unknown or legacy types) is active content when it lands on our origin:
 * an uploader-controlled <script> inside it would run with the app origin's
 * authority (stored XSS). Those types are served under OPAQUE_DOCUMENT_CSP.
 */
export const INLINE_SAFE_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
])

/**
 * Policy for every served document that is not natively inline-safe.
 * `sandbox` (no tokens) makes the rendered document opaque-origin and
 * script-free wherever it is opened, iframe or direct tab. The source
 * directives block outbound requests on top of that: sandbox alone still
 * loads remote images, so a tracking pixel in a mail body would notify the
 * sender when the preview is opened. Inline styles and embedded data:/blob:
 * images keep working, so HTML mail previews and XML views still render.
 */
export const OPAQUE_DOCUMENT_CSP =
  "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:"

/**
 * Canonical (lower-case, parameter-free) form of `mimeType` when it is one
 * of INLINE_SAFE_MIME_TYPES, else null. Legacy rows hold client-declared
 * strings, so parameters and case are tolerated on the way in but never
 * echoed back out.
 */
export function inlineSafeMimeType(mimeType: string | null | undefined): string | null {
  if (!mimeType) return null
  const essence = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  return INLINE_SAFE_MIME_TYPES.has(essence) ? essence : null
}

/**
 * The documents-bucket object key behind a proxied download path
 * (`sign/documents/<key>`, still percent-encoded), decoded so it can be
 * matched against `document_attachments.storage_path`. Null for upload paths
 * and anything else.
 */
export function documentKeyFromProxyPath(objectPath: string): string | null {
  const prefix = 'sign/documents/'
  if (!objectPath.startsWith(prefix)) return null
  try {
    return decodeURIComponent(objectPath.slice(prefix.length))
  } catch {
    return null
  }
}

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
