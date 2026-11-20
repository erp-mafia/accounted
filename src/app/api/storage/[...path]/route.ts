import { createLogger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/server'
import { contentDisposition } from '@/lib/api/content-disposition'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  OPAQUE_DOCUMENT_CSP,
  STORAGE_PROXY_ROUTE,
  documentKeyFromProxyPath,
  inlineSafeMimeType,
  readBodyWithCap,
  resolveUpstreamStorageUrl,
  storageTokenFromAuthorization,
  type StorageProxyResolution,
} from '@/lib/core/documents/storage-proxy'

/**
 * /api/storage/[...path]: same-origin proxy for signed Supabase Storage URLs.
 *
 * Why: agent sandboxes (Claude Desktop's code execution among them) only let
 * traffic out to the host the MCP server runs on. Signed Storage URLs point
 * at <project>.supabase.co, so the MCP model-free upload (PUT bytes to
 * upload_url) and signed document downloads were blocked inside such
 * sandboxes. The MCP tools now hand out URLs under this route instead (see
 * lib/core/documents/storage-proxy.ts), and this handler forwards them to
 * Storage unchanged.
 *
 * What the browser is told about the bytes is NOT taken from Storage. The
 * object's Content-Type and Content-Disposition are whatever the uploader
 * declared on PUT, and the proxy serves anonymous visitors on the app
 * origin: relaying them would let an HTML or SVG upload run scripts with our
 * origin's authority. Downloads are therefore served as opaque attachments
 * (application/octet-stream + OPAQUE_DOCUMENT_CSP) unless the object is a
 * document whose DB-validated mime type is natively inline-safe (PDF, raster
 * images), in which case that type is served.
 *
 * Auth: deliberately NOT withRouteContext. The caller is a sandbox with no
 * session, and the signed Storage token is the credential: Storage validates
 * it against the exact object path on every request, the same way it would
 * on the public Storage host. The proxy only forwards signed object paths on
 * the documents bucket, only to our own Storage origin, with a token
 * present; it never mints, reads or relays any key.
 *
 * The token arrives in the Authorization header, never in the URL (CASA
 * 2.1.1: no credential in a URL this application serves, where it would
 * reach access logs, browser history and Referer headers). A request with
 * `token` in its query string is refused before anything is forwarded. The
 * proxy's own request to Storage carries the token in the query because
 * that is the only place Storage reads it; that hop is server to server and
 * the URL is never logged or returned.
 *
 *   GET/HEAD  /api/storage/sign/documents/<key>[?download[=name]]  download
 *   PUT       /api/storage/upload/sign/documents/<key>             upload
 *   each with  Authorization: Bearer <signed token>
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const log = createLogger('api/storage-proxy')

/**
 * Above every caller's own cap (MCP upload 10 MB, document max 10 MB). The
 * browser inbox path does not come through here at all: this handler buffers
 * the PUT body inside a function, so on hosted it sits under the same 4.5 MB
 * platform ceiling, and the browser PUTs to the raw signed Storage URL
 * instead (lib/documents/direct-upload.ts).
 */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

const REQUEST_HEADERS_FORWARDED = [
  'content-type',
  'cache-control',
  'x-upsert',
  'range',
  'if-none-match',
  'if-modified-since',
] as const

// Deliberately without content-type and content-disposition: both are
// uploader-declared object metadata (see the module comment). And without
// cache-control: see BASE_HEADERS.
const RESPONSE_HEADERS_FORWARDED = [
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
] as const

// The sandbox fetch is not a browser, but a browser-based MCP client would
// need these and they cost nothing: the token still gates every request.
// Any origin, and never with credentials: the Authorization header a script
// sets itself is the credential, a cookie is not, so no
// Access-Control-Allow-Credentials. Authorization is not a safelisted
// request header and must be named here for the preflight to pass.
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Cache-Control, x-upsert, Range',
  'Access-Control-Max-Age': '600',
}

// On every answer, refusals included. nosniff: a served document is never
// sniffed into something executable. no-referrer: nothing that opens from a
// served document learns the address it was served from. no-store, never
// Storage's own Cache-Control: the URL no longer holds the token, so a cache
// keyed on the URL that kept a document would hand it to a request that
// carries no token at all.
const BASE_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'private, no-store',
  Vary: 'Authorization',
}

function withBaseHeaders(response: Response): Response {
  for (const [key, value] of Object.entries(BASE_HEADERS)) {
    response.headers.set(key, value)
  }
  return response
}

function objectPathOf(request: Request): string {
  const { pathname } = new URL(request.url)
  const prefix = `${STORAGE_PROXY_ROUTE}/`
  return pathname.startsWith(prefix) ? pathname.slice(prefix.length) : ''
}

interface ServedDocument {
  /** Canonical inline-safe type from the document row, or null when the row is missing or its type is not inline-safe. */
  mimeType: string | null
  fileName: string | null
}

/**
 * Look up the document row behind a proxied download key. Runs only after
 * Storage has accepted the signed token, so the caller has already proven
 * access to exactly this object; the row adds nothing they could not read
 * from the bytes. Every failure (no row, DB error, unsafe type) falls back
 * to the opaque default rather than trusting anything else.
 */
async function lookupServedDocument(objectPath: string): Promise<ServedDocument> {
  const key = documentKeyFromProxyPath(objectPath)
  if (!key) return { mimeType: null, fileName: null }
  try {
    const { data, error } = await createServiceClient()
      .from('document_attachments')
      .select('mime_type, file_name')
      .eq('storage_path', key)
      .limit(1)
    if (error) {
      log.warn('storage proxy document lookup failed', { message: error.message })
      return { mimeType: null, fileName: null }
    }
    const row = (data as { mime_type: string | null; file_name: string | null }[] | null)?.[0]
    if (!row) return { mimeType: null, fileName: null }
    return { mimeType: inlineSafeMimeType(row.mime_type), fileName: row.file_name }
  } catch (error) {
    log.warn('storage proxy document lookup threw', { message: (error as Error).message })
    return { mimeType: null, fileName: null }
  }
}

/** Last segment of the object key, decoded, as the filename of last resort. */
function fileNameFromObjectPath(objectPath: string): string {
  const last = objectPath.split('/').pop() ?? ''
  try {
    return decodeURIComponent(last) || 'download'
  } catch {
    return last || 'download'
  }
}

/**
 * Decide Content-Type / Content-Disposition / CSP for a GET or HEAD from
 * what the database says about the object, never from Storage's echo of
 * the uploader's metadata. Storage's own `?download[=name]` convention is
 * honoured for the disposition and filename so callers see the same
 * behaviour they got from the raw signed URL.
 */
async function servedContentHeaders(
  objectPath: string,
  search: URLSearchParams,
  upstreamOk: boolean,
): Promise<Record<string, string>> {
  const served = upstreamOk
    ? await lookupServedDocument(objectPath)
    : { mimeType: null, fileName: null }
  const downloadParam = search.get('download')
  const fileName = downloadParam || served.fileName || fileNameFromObjectPath(objectPath)

  if (served.mimeType) {
    return {
      'Content-Type': served.mimeType,
      'Content-Disposition': contentDisposition(
        downloadParam === null ? 'inline' : 'attachment',
        fileName,
      ),
    }
  }
  return {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': contentDisposition('attachment', fileName),
    'Content-Security-Policy': OPAQUE_DOCUMENT_CSP,
  }
}

/**
 * The upstream failure as it may be logged. An error from fetch can quote
 * the URL it was asked for, and that URL holds the token: the copy carries
 * the name and the message with the token cut out, and neither the original
 * stack nor its cause.
 */
function withoutToken(error: unknown, token: string | null): Error {
  const source = error instanceof Error ? error : new Error(String(error))
  const safe = new Error(token ? source.message.split(token).join('[token]') : source.message)
  safe.name = source.name
  return safe
}

const REJECTION_CODES: Record<Extract<StorageProxyResolution, { ok: false }>['reason'], string> = {
  unsupported_path: 'STORAGE_PROXY_UNSUPPORTED_PATH',
  missing_token: 'STORAGE_PROXY_TOKEN_REQUIRED',
  token_in_url: 'STORAGE_PROXY_TOKEN_IN_URL',
  api_key_as_token: 'STORAGE_PROXY_API_KEY_REFUSED',
  storage_unconfigured: 'STORAGE_PROXY_UNCONFIGURED',
}

function rejected(reason: keyof typeof REJECTION_CODES) {
  return withBaseHeaders(errorResponseFromCode(REJECTION_CODES[reason], log))
}

async function proxy(request: Request, method: 'GET' | 'HEAD' | 'PUT'): Promise<Response> {
  const url = new URL(request.url)
  const objectPath = objectPathOf(request)
  const token = storageTokenFromAuthorization(request.headers.get('authorization'))
  const resolved = resolveUpstreamStorageUrl(objectPath, url.searchParams, token)
  if (!resolved.ok) return rejected(resolved.reason)

  const headers = new Headers()
  for (const name of REQUEST_HEADERS_FORWARDED) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }

  let body: ArrayBuffer | undefined
  if (method === 'PUT') {
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      return withBaseHeaders(errorResponseFromCode('STORAGE_PROXY_BODY_TOO_LARGE', log))
    }
    // Stream with a cap: the declared length is advisory (absent or wrong),
    // and the token is only validated upstream, so never buffer an unbounded
    // body before measuring it.
    const read = await readBodyWithCap(request.body, MAX_UPLOAD_BYTES)
    if (read === null) {
      return withBaseHeaders(errorResponseFromCode('STORAGE_PROXY_BODY_TOO_LARGE', log))
    }
    body = read
    if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream')
  }

  let upstream: Response
  try {
    upstream = await fetch(resolved.url, {
      method,
      headers,
      ...(body ? { body } : {}),
      redirect: 'manual',
      cache: 'no-store',
    })
  } catch (error) {
    log.error('storage proxy upstream request failed', withoutToken(error, token), { method })
    return withBaseHeaders(errorResponseFromCode('STORAGE_PROXY_UPSTREAM_UNAVAILABLE', log))
  }

  const responseHeaders = new Headers(BASE_HEADERS)
  for (const name of RESPONSE_HEADERS_FORWARDED) {
    const value = upstream.headers.get(name)
    if (value) responseHeaders.set(name, value)
  }

  if (method === 'PUT') {
    // Storage answers an upload with its own small JSON envelope ({ Key }),
    // not object bytes, so its type is safe to relay.
    const upstreamType = upstream.headers.get('content-type')
    if (upstreamType) responseHeaders.set('Content-Type', upstreamType)
  } else {
    const served = await servedContentHeaders(objectPath, url.searchParams, upstream.ok)
    for (const [key, value] of Object.entries(served)) responseHeaders.set(key, value)
  }

  return new Response(method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  })
}

export async function GET(request: Request) {
  return proxy(request, 'GET')
}

export async function HEAD(request: Request) {
  return proxy(request, 'HEAD')
}

export async function PUT(request: Request) {
  return proxy(request, 'PUT')
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}
