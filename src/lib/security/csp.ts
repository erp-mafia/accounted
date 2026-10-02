/**
 * Content Security Policy for every response the app serves.
 *
 * One builder, two variants, so every directive except script-src is written
 * exactly once:
 *
 *   - Nonce policy (a nonce is passed): the proxy (src/proxy.ts) generates a
 *     fresh nonce per request, sets this policy on the response and forwards
 *     it upstream as a request header. Next.js reads the nonce out of that
 *     request header and stamps it on every script it renders itself; the
 *     root layout reads CSP_NONCE_HEADER for the few scripts it renders on its
 *     own. script-src trusts those scripts and whatever they load
 *     ('strict-dynamic'), and nothing inline without the nonce.
 *   - Static policy (no nonce): set by next.config.ts headers() on the
 *     responses the proxy never touches (static assets, the /rl analytics
 *     rewrite, .well-known, ...) and on the document routes that keep a
 *     policy of their own (see proxyOwnsContentSecurityPolicy). No inline
 *     script runs there at all.
 *
 * The two must never both land on one response: Next.js applies every
 * matching headers() rule AND the proxy's header, and a browser enforces
 * every CSP header it receives. STATIC_POLICY_SOURCE is therefore derived
 * from the proxy matcher's own exclusion list, and a test asserts that the
 * two partition the path space.
 *
 * style-src keeps 'unsafe-inline' on purpose: React style attributes and the
 * inline styles of Radix, framer-motion and next/font need it, and a nonce in
 * style-src would make browsers ignore 'unsafe-inline' for style attributes
 * as well.
 *
 * No path aliases in this file: next.config.ts imports it directly.
 */

/**
 * Request header that carries the per-request nonce from the proxy to the
 * root layout and to the route handlers that render their own HTML page.
 */
export const CSP_NONCE_HEADER = 'x-nonce'

/**
 * The paths the proxy matcher excludes, as the body of its negative
 * lookahead. src/proxy.ts must spell its matcher as
 * `/((?!${PROXY_MATCHER_EXCLUSIONS}).*)` literally (Next.js reads the matcher
 * statically, so it cannot import this constant); a test holds the two
 * together.
 */
export const PROXY_MATCHER_EXCLUSIONS =
  '_next/static|_next/image|favicon.ico|\\.well-known|rl/|sw\\.js|sw-register\\.js|manifest\\.json|manifest\\.webmanifest|icons/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|js|json)$'

/**
 * API routes that serve stored documents and answer with a policy of their
 * own (OPAQUE_DOCUMENT_CSP for active content, and `frame-ancestors 'self'`
 * on the inline preview so the document sheet can frame it). The proxy
 * leaves their CSP to the headers() rules exactly as before the nonce
 * policy existed, so a document never ends up with the app's page policy in
 * place of the one its route chose.
 */
const DOCUMENT_ROUTE_RE = /^\/api\/(?:storage(?:\/|$)|documents\/[^/]+\/inline$)/

/**
 * headers() `source` for every path that carries the static policy: all
 * paths the proxy never sees, plus the storage proxy route. The inline
 * document route has its own rule in next.config.ts and matches neither.
 */
export const STATIC_POLICY_SOURCE = `/((?=${PROXY_MATCHER_EXCLUSIONS}|api/storage(?:/|$)).*)`

/** Whether the proxy sets the nonce policy on this path's response. */
export function proxyOwnsContentSecurityPolicy(pathname: string): boolean {
  return !DOCUMENT_ROUTE_RE.test(pathname)
}

export interface CspOrigins {
  /** Supabase API origin (https, or http on a LAN self-host), or ''. */
  supabaseUrl: string
  /** Supabase Realtime WebSocket origin (wss/ws), or ''. */
  supabaseWsUrl: string
  /** Whether Cloudflare Turnstile may load its script and frame. */
  turnstile: boolean
}

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com'

/**
 * The origins the policy allows, from the public env.
 *
 * Literal `process.env.NEXT_PUBLIC_*` reads on purpose. next.config.ts calls
 * this at build time, and in the proxy bundle the compiler inlines the same
 * reads, so the generic Docker image carries the `__NEXT_PUBLIC_*__`
 * sentinels in both places and docker-entrypoint.sh substitutes the real
 * values at container start (routes-manifest.json and the proxy chunk under
 * .next/server/chunks are both inside its SUBST_PATHS).
 */
export function cspOriginsFromEnv(): CspOrigins {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  return {
    supabaseUrl,
    // WebSocket origin for Supabase Realtime. Hosted projects are covered by
    // the wss://*.supabase.co wildcard, but a SELF-HOSTED Supabase URL is
    // not: Realtime opens wss://<supabase-host>/realtime/v1/websocket, and
    // WebKit throws synchronously on a CSP-blocked `new WebSocket()`,
    // unmounting the dashboard into the error boundary (issue #893). The
    // Docker image bakes the __NEXT_PUBLIC_SUPABASE_WS_URL__ sentinel at
    // build time and docker-entrypoint.sh substitutes the real value at
    // runtime (a build-time https-to-wss replace would only rewrite the
    // sentinel); the fallback derives wss:/ws: from the https/http URL for
    // non-Docker builds where the real URL is present at build time. An
    // empty supabaseUrl stays empty (extra whitespace is valid in CSP).
    supabaseWsUrl:
      process.env.NEXT_PUBLIC_SUPABASE_WS_URL ??
      supabaseUrl.replace(/^http(s?):/, 'ws$1:'),
    // Hosted builds only widen the policy when Turnstile is prepared. The
    // generic Docker image builds with a site-key sentinel, so it always
    // includes this origin and can safely enable Turnstile later through
    // runtime substitution.
    turnstile: Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY),
  }
}

export interface ContentSecurityPolicyOptions {
  origins: CspOrigins
  /**
   * This request's nonce: script-src then trusts it plus 'strict-dynamic'.
   * Omit it for the static policy.
   */
  nonce?: string
  /** `next dev`: React needs eval to rebuild server error stacks. */
  isDev: boolean
}

/**
 * The policy string. Every directive but script-src is unchanged from the
 * single static next.config.ts policy this replaced (the test pins them).
 */
export function buildContentSecurityPolicy({
  origins,
  nonce,
  isDev,
}: ContentSecurityPolicyOptions): string {
  const { supabaseUrl, supabaseWsUrl } = origins
  const turnstileOrigin = origins.turnstile ? ` ${TURNSTILE_ORIGIN}` : ''
  // With 'strict-dynamic' a CSP3 browser ignores 'self' and the host
  // entries for scripts: every script must carry the nonce or be inserted by
  // one that does (Next.js chunks, PostHog's lazy bundles from /rl,
  // Turnstile, Speed Insights). 'self' and the hosts stay as the fallback for
  // browsers that predate 'strict-dynamic'. No 'unsafe-inline' in either
  // variant.
  const trust = nonce ? ` 'nonce-${nonce}' 'strict-dynamic'` : ''
  const evalSource = isDev ? " 'unsafe-eval'" : ''
  return [
    "default-src 'self'",
    // No analytics hosts here on purpose. PostHog is routed through the
    // same-origin `/rl` rewrite (next.config.ts), so ingestion is covered by
    // `connect-src 'self'`. Adding `*.posthog.com` back would re-widen the
    // policy for no benefit and undo the ad-blocker resistance.
    `connect-src 'self' ${supabaseUrl} ${supabaseWsUrl} https://*.supabase.co wss://*.supabase.co https://*.enablebanking.com`,
    "style-src 'self' 'unsafe-inline' https://*.enablebanking.com",
    `script-src 'self'${trust}${evalSource} https://*.enablebanking.com${turnstileOrigin}`,
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    "worker-src 'self' blob:",
    // object-src must explicitly allow blob:: Chrome's built-in PDF viewer
    // renders inline PDFs via an internal <embed>, which falls under
    // object-src. Without this, blob:-URL invoice previews (created via
    // URL.createObjectURL on /api/invoices/preview-pdf responses) show
    // "Det här innehållet har blockerats" in Chrome. Firefox uses PDF.js and
    // Edge uses its own viewer, so neither hits this. See crbug.com/271452.
    "object-src 'self' blob:",
    `frame-src 'self' blob: ${supabaseUrl}${turnstileOrigin}`,
    "frame-ancestors 'none'",
    // A nonce only protects scripts whose URL the page chose: an injected
    // <base href> would re-point every nonce-carrying relative src
    // (/_next/static/...) at another host. No page sets a <base> element.
    "base-uri 'self'",
  ].join('; ')
}

/**
 * A fresh nonce: 128 bits from Web Crypto, base64. Available in the Node and
 * edge runtimes alike, so the proxy needs no Node-only import.
 */
export function generateCspNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * The characters Next.js accepts in a nonce source (its
 * getScriptNonceFromHeader): base64 and base64url, with padding. Anything
 * else is not something the proxy produced.
 */
const NONCE_RE = /^[A-Za-z0-9+/_-]+={0,2}$/

/**
 * Nonce for a route handler that renders its own HTML page with inline
 * scripts: the proxy's nonce when the request came through the proxy, else a
 * fresh one. Sharing the proxy's nonce keeps the page working whichever CSP
 * header reaches the browser: the proxy's, the route's own, or both (a
 * self-hosted `next start` keeps the header the proxy set and drops the
 * route's).
 */
export function requestCspNonce(headers: Pick<Headers, 'get'>): string {
  const forwarded = headers.get(CSP_NONCE_HEADER)
  return forwarded && NONCE_RE.test(forwarded) ? forwarded : generateCspNonce()
}
