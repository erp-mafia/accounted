import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const isDev = process.env.NODE_ENV === "development";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

const activepiecesUrl = process.env.ACTIVEPIECES_URL ?? "";

const cspDirectives = [
  "default-src 'self'",
  `connect-src 'self' ${supabaseUrl} https://*.supabase.co wss://*.supabase.co https://*.enablebanking.com https://*.recapt.app`,
  `style-src 'self' 'unsafe-inline' https://*.enablebanking.com`,
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""} https://*.enablebanking.com https://cdn.recapt.app`,
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  "worker-src 'self' blob:",
  // object-src must explicitly allow blob: — Chrome's built-in PDF viewer
  // renders inline PDFs via an internal <embed>, which falls under
  // object-src. Without this, blob:-URL invoice previews (created via
  // URL.createObjectURL on /api/invoices/preview-pdf responses) show
  // "Det här innehållet har blockerats" in Chrome. Firefox uses PDF.js and
  // Edge uses its own viewer, so neither hits this. See crbug.com/271452.
  "object-src 'self' blob:",
  `frame-src 'self' blob: ${supabaseUrl}${activepiecesUrl ? ` ${activepiecesUrl}` : ""}`,
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  output: 'standalone',
  async redirects() {
    return [
      {
        source: '/nyckeltal',
        destination: '/kpi',
        permanent: true,
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
    ]
  },
  async headers() {
    // The catch-all excludes /api/documents/:id/inline so the strict
    // X-Frame-Options: DENY + frame-ancestors 'none' don't conflict with
    // the embeddable override below — Next.js applies every matching
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
      // Chrome's built-in PDF viewer — Chrome renders inline PDFs through
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
