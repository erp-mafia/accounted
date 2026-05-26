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
    // the embeddable override below. Multiple matching header rules in
    // Next.js can end up sending duplicate header values to the browser
    // (Chrome/Firefox then fall back to the most restrictive), which was
    // showing up as "Det här innehållet har blockerats" in the verifikat
    // document preview Sheet.
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
            value: "default-src 'none'; script-src 'none'; object-src 'none'; frame-ancestors 'self'",
          },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
