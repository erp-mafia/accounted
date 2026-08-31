import { createLogger } from '@/lib/logger'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  STORAGE_PROXY_ROUTE,
  readBodyWithCap,
  resolveUpstreamStorageUrl,
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
 * Auth: deliberately NOT withRouteContext. The caller is a sandbox with no
 * session, and the signed token in the query string is the credential:
 * Storage validates it against the exact object path on every request, the
 * same way it would on the public Storage host. The proxy only forwards
 * signed object paths on the documents bucket, only to our own Storage
 * origin, with a token present; it never mints, reads or relays any key.
 *
 *   GET/HEAD  /api/storage/sign/documents/<key>?token=...        download
 *   PUT       /api/storage/upload/sign/documents/<key>?token=... upload
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

const RESPONSE_HEADERS_FORWARDED = [
  'content-type',
  'content-length',
  'content-disposition',
  'content-range',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified',
] as const

// The sandbox fetch is not a browser, but a browser-based MCP client would
// need these and they cost nothing: the token still gates every request.
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, x-upsert, Range',
  'Access-Control-Max-Age': '600',
}

function withCors(response: Response): Response {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value)
  }
  return response
}

function objectPathOf(request: Request): string {
  const { pathname } = new URL(request.url)
  const prefix = `${STORAGE_PROXY_ROUTE}/`
  return pathname.startsWith(prefix) ? pathname.slice(prefix.length) : ''
}

function rejected(reason: 'unsupported_path' | 'missing_token' | 'storage_unconfigured') {
  const code =
    reason === 'unsupported_path'
      ? 'STORAGE_PROXY_UNSUPPORTED_PATH'
      : reason === 'missing_token'
        ? 'STORAGE_PROXY_TOKEN_REQUIRED'
        : 'STORAGE_PROXY_UNCONFIGURED'
  return withCors(errorResponseFromCode(code, log))
}

async function proxy(request: Request, method: 'GET' | 'HEAD' | 'PUT'): Promise<Response> {
  const url = new URL(request.url)
  const resolved = resolveUpstreamStorageUrl(objectPathOf(request), url.searchParams)
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
      return withCors(errorResponseFromCode('STORAGE_PROXY_BODY_TOO_LARGE', log))
    }
    // Stream with a cap: the declared length is advisory (absent or wrong),
    // and the token is only validated upstream, so never buffer an unbounded
    // body before measuring it.
    const read = await readBodyWithCap(request.body, MAX_UPLOAD_BYTES)
    if (read === null) {
      return withCors(errorResponseFromCode('STORAGE_PROXY_BODY_TOO_LARGE', log))
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
    log.error('storage proxy upstream request failed', error as Error, { method })
    return withCors(errorResponseFromCode('STORAGE_PROXY_UPSTREAM_UNAVAILABLE', log))
  }

  const responseHeaders = new Headers(CORS_HEADERS)
  for (const name of RESPONSE_HEADERS_FORWARDED) {
    const value = upstream.headers.get(name)
    if (value) responseHeaders.set(name, value)
  }
  // Never let a served document be sniffed into something executable.
  responseHeaders.set('X-Content-Type-Options', 'nosniff')

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
