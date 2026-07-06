/**
 * Common security headers for public v1 responses.
 *
 * Applied to discovery routes (`/llms.txt`, `/.well-known/skills/index.json`,
 * `/api/v1/openapi.json`) that bypass the auth wrapper.
 *
 * The wrapped routes don't need these explicitly: NextResponse's defaults +
 * the auth wrapper's stamping cover them. Public routes are an exception
 * because they're plain `NextResponse.json/text` returns with caching.
 *
 *   X-Content-Type-Options: nosniff  : block MIME sniffing on text/json
 *   Referrer-Policy: strict-origin...: limit referrer leakage if a link is
 *                                       embedded somewhere unexpected
 *   X-Frame-Options: DENY            : discovery surfaces should never
 *                                       legitimately render in a frame
 */

/**
 * Headers applied to BOTH public discovery routes and authenticated v1
 * responses. Includes CSP, HSTS, and frame/sniff/referrer protections, but
 * NOT X-Robots-Tag: discovery routes (llms.txt, skills index, OpenAPI)
 * exist to be crawled by AI agents; authenticated routes get an additional
 * X-Robots-Tag at the wrapper level via WRAPPED_RESPONSE_NOAI_HEADERS.
 */
export const PUBLIC_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  // Discovery routes return JSON or plain text: no script, style, image, or
  // form contexts. `default-src 'none'` is the strictest possible CSP and
  // costs nothing here.
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  // HSTS: every Accounted deployment is HTTPS-only. 1 year is the standard
  // production value; includeSubDomains because the apex serves everything.
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
}

/**
 * Additional headers applied ONLY to authenticated v1 responses. AI bots
 * that respect X-Robots-Tag (Claude, ChatGPT, Perplexity, Google-Extended)
 * will skip these payloads for training; others will ignore the hint.
 * Public discovery routes deliberately omit this so they remain
 * AI-discoverable.
 */
export const WRAPPED_RESPONSE_HEADERS: Record<string, string> = {
  ...PUBLIC_SECURITY_HEADERS,
  'X-Robots-Tag': 'noai, noimageai',
}

/**
 * Merge the public security headers onto an arbitrary header dict so callers
 * can keep their own Content-Type / Cache-Control entries.
 */
export function withPublicSecurityHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...PUBLIC_SECURITY_HEADERS, ...extra }
}
