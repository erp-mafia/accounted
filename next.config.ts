import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { LEGACY_HOST_REDIRECT_EXCLUSIONS } from "./lib/domains/legacy-redirect";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const isDev = process.env.NODE_ENV === "development";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

// Hosted builds only widen the CSP when Turnstile is prepared. The generic
// Docker image builds with a site-key sentinel, so it always includes this
// origin and can safely enable Turnstile later through runtime substitution.
const turnstileOrigin = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
  ? " https://challenges.cloudflare.com"
  : "";

// WebSocket origin for Supabase Realtime. Hosted projects are covered by the
// wss://*.supabase.co wildcard below, but a SELF-HOSTED Supabase URL is not:
// Realtime opens wss://<supabase-host>/realtime/v1/websocket, and WebKit
// throws synchronously on a CSP-blocked `new WebSocket()`, unmounting the
// dashboard into the error boundary (issue #893). The Docker image bakes the
// __NEXT_PUBLIC_SUPABASE_WS_URL__ sentinel at build time and
// docker-entrypoint.sh substitutes the real value at runtime (a build-time
// https-to-wss replace would only rewrite the sentinel); the fallback derives
// wss:/ws: from the https/http URL for non-Docker builds where the real URL
// is present at build time. Empty supabaseUrl stays empty, mirroring how
// ${supabaseUrl} is interpolated below (extra whitespace is valid in CSP).
const supabaseWsUrl =
  process.env.NEXT_PUBLIC_SUPABASE_WS_URL ??
  supabaseUrl.replace(/^http(s?):/, "ws$1:");

const cspDirectives = [
  "default-src 'self'",
  // No analytics hosts here on purpose. PostHog replaced Recapt and is
  // routed through the same-origin `/rl` rewrite below, so ingestion is
  // covered by `connect-src 'self'` and its lazy-loaded replay/survey
  // bundles by `script-src 'self'`. Adding `*.posthog.com` back would
  // re-widen the policy for no benefit and undo the ad-blocker resistance.
  `connect-src 'self' ${supabaseUrl} ${supabaseWsUrl} https://*.supabase.co wss://*.supabase.co https://*.enablebanking.com`,
  `style-src 'self' 'unsafe-inline' https://*.enablebanking.com`,
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://*.enablebanking.com${turnstileOrigin}`,
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
].join("; ");

const nextConfig: NextConfig = {
  // Standalone output feeds the Docker image (Dockerfile copies
  // .next/standalone). Vercel never reads it: its build adapter
  // (onBuildComplete) traces and packages functions itself, and as of Next
  // 16.3 the adapter path no longer leaves the next-server.js.nft.json the
  // standalone writer copies from, so the build failed with ENOENT right after
  // "Running onBuildComplete from Vercel" (#1750 preview). VERCEL=1 is a
  // system env var on every Vercel build; self-hosted and local builds keep
  // the standalone directory.
  output: process.env.VERCEL ? undefined : 'standalone',
  // Build id inlined into the client bundle so a running tab can tell when a
  // newer deploy is live (see components/system/DeployReloadPrompt). On Vercel
  // this is the commit SHA; empty elsewhere (dev / self-hosted), which disables
  // the check. The /api/version route reads the same var at runtime to compare.
  env: {
    NEXT_PUBLIC_BUILD_ID: process.env.VERCEL_GIT_COMMIT_SHA ?? '',
  },
  // The build type-checks what ships: tsconfig.build.json extends
  // tsconfig.json and excludes tests. tsconfig.json stays the editor/ESLint
  // view of the whole repo. Next 16.3's default CLI checker checks the complete
  // project it is given and no longer drops test-file diagnostics the way the
  // old API checker did, so without this the build would fail on test typing
  // debt that vitest never type-checks (see DECISIONS.md 2026-08-20).
  typescript: {
    tsconfigPath: 'tsconfig.build.json',
  },
  // Multiple lockfiles exist above this project (e.g. a parent yarn.lock),
  // which makes Turbopack infer the wrong workspace root. Pin it explicitly.
  turbopack: {
    root: projectRoot,
  },
  // PostHog sends trailing-slash API requests; without this Next 308s them
  // and the events are lost. Required by the reverse proxy below.
  skipTrailingSlashRedirect: true,
  experimental: {
    optimizePackageImports: ['recharts', 'date-fns', 'framer-motion'],
  },
  // PostHog reverse proxy. Keeping analytics same-origin buys three things:
  // the strict CSP below needs NO posthog hosts (`connect-src 'self'` already
  // covers ingestion, `script-src 'self'` the lazy-loaded replay/survey
  // bundles), tracking blockers have no third-party host to match, and the
  // Recapt host allowlist is replaced by nothing at all.
  //
  // `/rl` is deliberately meaningless: PostHog's own guidance is that obvious
  // prefixes (/analytics, /tracking, /telemetry, /posthog, and increasingly
  // /ingest) are on blocker filter lists. It must stay in sync with `api_host`
  // in instrumentation-client.ts AND with the matcher exclusion in proxy.ts,
  // or middleware redirects the ingestion POSTs to /login.
  //
  // Both /static/* and /array/* must point at the ASSETS origin, not the
  // ingestion origin: array/ serves the config bundle and is easy to miss.
  async rewrites() {
    return [
      {
        source: '/rl/static/:path*',
        destination: 'https://eu-assets.i.posthog.com/static/:path*',
      },
      {
        source: '/rl/array/:path*',
        destination: 'https://eu-assets.i.posthog.com/array/:path*',
      },
      {
        source: '/rl/:path*',
        destination: 'https://eu.i.posthog.com/:path*',
      },
    ]
  },
  async redirects() {
    const appUrlForRedirect = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, '')
    return [
      {
        source: '/nyckeltal',
        destination: '/kpi',
        permanent: true,
      },
      // The kontoplan lived as a tab on /bookkeeping until 2026-07-01 (#850);
      // old bookmarks and stale links still carry ?tab=accounts.
      {
        source: '/bookkeeping',
        has: [{ type: 'query', key: 'tab', value: 'accounts' }],
        destination: '/chart-of-accounts',
        permanent: false,
      },
      // Docs canonicalised to docs.gnubok.se. Every `docs_url` field on the
      // v1 error envelope still points at this host; the 308 forwards both
      // humans and agents to the docs subdomain without us needing to
      // mass-update structured-errors.
      {
        source: '/docs/api',
        destination: 'https://docs.gnubok.se/',
        permanent: true,
      },
      {
        source: '/docs/api/:path*',
        destination: 'https://docs.gnubok.se/:path*',
        permanent: true,
      },
      {
        source: '/llms-full.txt',
        destination: 'https://docs.gnubok.se/llms-full.txt',
        permanent: true,
      },
      // Dual-domain cutover (2026-07): the user-facing app moves to
      // app.accounted.se; app.gnubok.se stays alive for machine traffic
      // (MCP connectors, API keys, the Skatteverket OAuth callback,
      // webhooks, crons). Only browser page traffic is forwarded: /api and
      // /.well-known must keep answering on the legacy host, and /_next is
      // excluded so already-open tabs keep loading assets until their next
      // navigation. The redirect arms itself only once NEXT_PUBLIC_APP_URL
      // points somewhere other than the legacy host, so merging this is
      // inert and the actual cutover is the env flip + redeploy. Kept
      // non-permanent until the cutover has soaked.
      //
      // auth/ and reset-password are excluded so email links that carry a
      // PKCE code (password reset, signup confirmation) sent before the
      // cutover still complete on the legacy host, where their code
      // verifier / recovery-session cookies live (#1092). login and MFA
      // pages are deliberately NOT excluded: serving a usable login page
      // on the legacy host would establish sessions there and bounce
      // users in a redirect loop.
      ...(appUrlForRedirect &&
      appUrlForRedirect.startsWith('https://') &&
      !appUrlForRedirect.includes('app.gnubok.se')
        ? [
            {
              source: `/:path(${LEGACY_HOST_REDIRECT_EXCLUSIONS}.*)`,
              has: [{ type: 'host' as const, value: 'app.gnubok.se' }],
              destination: `${appUrlForRedirect}/:path`,
              permanent: false,
            },
          ]
        : []),
    ]
  },
  async headers() {
    // The catch-all excludes /api/documents/:id/inline so the strict
    // X-Frame-Options: DENY + frame-ancestors 'none' don't conflict with
    // the embeddable override below: Next.js applies every matching
    // header rule, and duplicate X-Frame-Options/CSP values trigger
    // "Det här innehållet har blockerats" in Chromium browsers.
    return [
      {
        source: "/((?!api/documents/[^/]+/inline$).*)",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          {
            key: "Content-Security-Policy",
            value: cspDirectives,
          },
        ],
      },
      // Document inline-preview proxy must be embeddable in same-origin
      // iframes (used by the verifikat document preview Sheet). Excluded
      // from the catch-all above so these values aren't shadowed by the
      // stricter defaults.
      //
      // CSP is intentionally minimal: only `frame-ancestors 'self'`
      // prevents cross-origin clickjacking on the user's documents.
      // Adding `object-src 'none'` (or `default-src 'none'`) here breaks
      // Chrome's built-in PDF viewer: Chrome renders inline PDFs through
      // an internal <embed>, which the directive forbids, surfacing as
      // "Det här innehållet har blockerats" in the document preview Sheet.
      // Firefox uses PDF.js and Edge uses its own viewer, so neither hits
      // this. See crbug.com/271452. X-Content-Type-Options: nosniff plus
      // the explicit Content-Type from the route handler already prevent
      // MIME-confusion abuse.
      {
        source: "/api/documents/:id/inline",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "X-Frame-Options",
            value: "SAMEORIGIN",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=()",
          },
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'self'",
          },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
