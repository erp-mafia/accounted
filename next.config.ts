import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { LEGACY_HOST_REDIRECT_EXCLUSIONS } from "./src/lib/domains/legacy-redirect";
import {
  STATIC_POLICY_SOURCE,
  buildContentSecurityPolicy,
  cspOriginsFromEnv,
} from "./src/lib/security/csp";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const isDev = process.env.NODE_ENV === "development";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

// Brand logos (WL-12 slice A3) are served from Supabase Storage public
// objects. The tenant-logo <Image> elements (components/branding/) render
// them `unoptimized` since issue #2203: this allowlist is fixed at build
// time, and the generic Docker image bakes a sentinel for
// NEXT_PUBLIC_SUPABASE_URL that docker-entrypoint.sh substitutes only at
// container start, so the optimizer rejected the runtime host with 400
// '"url" parameter is not allowed'. The pattern is kept for builds where the
// real URL is present at build time (hosted, local) so any other remote
// image from the same public bucket still passes. Narrow on purpose: public
// storage objects only. try/catch because the sentinel is not a parseable
// URL; no hostname simply means no remote images are allowed, as before.
let supabaseImageHostname = "";
try {
  supabaseImageHostname = supabaseUrl ? new URL(supabaseUrl).hostname : "";
} catch {
  supabaseImageHostname = "";
}

// The CSP for every response the proxy does not stamp with its per-request
// nonce policy: static assets, the /rl analytics rewrite, .well-known, the
// storage proxy. Built at build time from the public env; the generic Docker
// image carries sentinels here that docker-entrypoint.sh substitutes in
// routes-manifest.json. See lib/security/csp.ts for both policies.
const staticContentSecurityPolicy = buildContentSecurityPolicy({
  origins: cspOriginsFromEnv(),
  isDev,
});

const nextConfig: NextConfig = {
  // No `X-Powered-By: Next.js`: it only tells a scanner which framework (and
  // which set of known issues) to try.
  poweredByHeader: false,
  // Standalone output feeds the Docker image (Dockerfile copies
  // .next/standalone). Vercel never reads it: its build adapter
  // (onBuildComplete) traces and packages functions itself, and as of Next
  // 16.3 the adapter path no longer leaves the next-server.js.nft.json the
  // standalone writer copies from, so the build failed with ENOENT right after
  // "Running onBuildComplete from Vercel" (#1750 preview). VERCEL=1 is a
  // system env var on every Vercel build; self-hosted and local builds keep
  // the standalone directory.
  output: process.env.VERCEL ? undefined : 'standalone',
  ...(supabaseImageHostname
    ? {
        images: {
          remotePatterns: [
            {
              protocol: "https" as const,
              hostname: supabaseImageHostname,
              pathname: "/storage/v1/object/public/**",
            },
          ],
        },
      }
    : {}),
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
  // The Arkiv reading layer (lib/documents/read). AnyDoc is a native napi
  // reader for Office files: its prebuilt .node binary must be required at
  // runtime, never bundled. unpdf (pdf.js, pure JavaScript) is kept external
  // too, so the hosted function runs the same files Node runs in the tests
  // rather than a re-bundled copy of pdf.js.
  //
  // The Bedrock SDK (lib/ai/provider) is external as well: bundling it splits
  // its AWS SDK / @smithy dependency tree across server chunks, and on
  // 2026-10-04 Turbopack named two different splits the same chunk
  // ("Two or more assets with different content were emitted to the same
  // output path"), which failed every production build from main. Loaded
  // from node_modules at runtime, the AWS SDK never enters the bundle.
  serverExternalPackages: ['@firecrawl/anydoc', 'unpdf', 'heic-convert', 'heic-decode', 'libheif-js', '@anthropic-ai/bedrock-sdk'],
  experimental: {
    optimizePackageImports: ['recharts', 'date-fns', 'framer-motion'],
    // Client router cache for dynamic routes: a page visited in the last
    // 30 s (back/forward, re-clicking a nav item) re-renders from the cached
    // RSC payload instead of a new server request through the auth proxy.
    // Mutation flows already call router.refresh() where a stale server
    // render would mislead (16 sites); the client-side reference-data cache
    // (lib/reference-data) is independent of this and refreshes on its own.
    // Default was 0 (always refetch). Static routes keep the 5 min default.
    staleTimes: { dynamic: 30, static: 300 },
    // Vercel's standard build container OOM-kills the build since 2026-08-26
    // (the tree outgrew it; SIGKILL during "Creating an optimized production
    // build"). Two knobs, disjoint phases:
    // - compile phase (Turbopack, where the kills happen): evict finished
    //   tasks to the on-disk cache after every snapshot instead of the lazier
    //   'auto' default. Trades some compile speed for a bounded working set;
    //   requires the persistent FS cache, which is on by default in Next 16.
    turbopackMemoryEviction: 'full',
    // - static-generation phase: cap prerender workers (default is cores-1;
    //   each is a full Node process on the shared container RAM).
    cpus: 2,
  },
  // PostHog reverse proxy. Keeping analytics same-origin buys three things:
  // the strict CSP needs NO posthog hosts (`connect-src 'self'` already
  // covers ingestion, and the lazy-loaded replay/survey bundles are inserted
  // by the nonce-trusted SDK, which 'strict-dynamic' allows), tracking
  // blockers have no third-party host to match, and the Recapt host
  // allowlist is replaced by nothing at all.
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
    // X-Frame-Options: DENY doesn't conflict with the embeddable override
    // below (the proxy likewise leaves that route's CSP alone, so its
    // frame-ancestors 'self' is the only one): Next.js applies every
    // matching header rule, and duplicate X-Frame-Options/CSP values
    // trigger "Det här innehållet har blockerats" in Chromium browsers.
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
        ],
      },
      // Content-Security-Policy, only where the proxy does not set its
      // per-request nonce policy (src/proxy.ts): the paths its matcher skips
      // and the storage proxy route. Never on a path the proxy stamps, or the
      // browser would enforce both headers (lib/security/csp.ts).
      {
        source: STATIC_POLICY_SOURCE,
        headers: [
          {
            key: "Content-Security-Policy",
            value: staticContentSecurityPolicy,
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
