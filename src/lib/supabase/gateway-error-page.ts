/**
 * A gateway's error page, answered as one short error PostgREST could have sent.
 *
 * PostgREST answers every error with JSON. A 5xx with a body that is not JSON
 * came from in front of it: Cloudflare or Supabase's gateway. postgrest-js
 * makes such a body the error's whole message ({ message: body }), so every
 * call site that throws `${error.message}` carried the page. On 2026-11-16
 * the database host answered HTTP 500 with Cloudflare's 4.7 KB "Script not
 * found" page (error 1104) for over 20 minutes; its Ray ID and time differ on
 * every request, so the one outage became 14 issues in PostHog, each value a
 * page of HTML.
 *
 * Normalised in the fetch of the server clients (lib/supabase/server.ts,
 * lib/supabase/service-client.ts): the response keeps its status and headers,
 * so postgrest-js still retries what it retries (503, 520, after Retry-After),
 * and its body becomes JSON with one stable message: the status and the
 * page's <title>, where Cloudflare and nginx name the error. Nothing else of
 * the page, since anything else may differ per request. A JSON body, an empty
 * one (a HEAD request's), a status under 500 and a request that is not
 * PostgREST's pass through as they are.
 *
 * Isomorphic: no server-only imports.
 */
import { isPostgrestRequest } from '@/lib/supabase/page-past-end'

const TITLE = /<title[^>]*>([^<]*)<\/title>/i
/** A page names itself in its head: reading further only costs time. */
const HEAD_CHARS = 16_384
const TITLE_MAX = 100

function isJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    // Not JSON is the answer asked for, not a failure: the page is the gateway's.
    return false
  }
}

/** The message a gateway's page becomes: the status, and the page's title when it has one. */
export function gatewayErrorMessage(status: number, page: string): string {
  const title = Array.from((TITLE.exec(page.slice(0, HEAD_CHARS))?.[1] ?? '').replace(/\s+/g, ' ').trim())
    .slice(0, TITLE_MAX).join('').trim()
  return title ? `Supabase answered HTTP ${status} without JSON: ${title}` : `Supabase answered HTTP ${status} without JSON`
}

/**
 * A fetch for supabase-js (global.fetch) that answers a PostgREST 5xx whose
 * body is not JSON with that body's short message as JSON. `base` is the
 * fetch to send with, the global one when absent, looked up per request as
 * supabase-js does.
 */
export function withShortGatewayErrorPage(base?: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await (base ?? globalThis.fetch)(input, init)
    if (response.status < 500 || !isPostgrestRequest(input)) return response
    let body: string
    try {
      body = await response.clone().text()
    } catch {
      // The body could not be read: postgrest-js meets the same failure on the original.
      return response
    }
    if (body === '' || isJson(body)) return response
    const headers = new Headers(response.headers)
    headers.set('content-type', 'application/json; charset=utf-8')
    headers.delete('content-length')
    headers.delete('content-encoding')
    return new Response(JSON.stringify({ message: gatewayErrorMessage(response.status, body) }), {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }
}
