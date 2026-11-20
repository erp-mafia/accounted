import type { MetadataRoute } from 'next'

/**
 * The paths a crawler may fetch: the anonymous agent-discovery surfaces that
 * app/llms.txt advertises (the index itself, the docs that 308 on to
 * docs.accounted.se, the OpenAPI spec and the skills catalogue under
 * /.well-known). They exist for crawlers and IDE agents, and a fetcher that
 * honours robots.txt must keep reaching them.
 */
const ROBOTS_ALLOWED_PATHS = [
  '/llms.txt',
  '/llms-full.txt',
  '/docs',
  '/api/v1/openapi.json',
  '/.well-known/',
] as const

/**
 * /robots.txt for every host this app answers on: app.accounted.se, the
 * legacy app.gnubok.se, the white-label byrå hosts and self-hosted installs.
 *
 * This is a signed-in accounting product, not a content site. Nothing behind
 * the login and none of the token links (/invite, /payslip, /koppla, /betala,
 * /attest, /invoice-action, /reset-password, /auth) may be crawled, and the
 * login and legal pages would only be indexed as duplicates across every
 * branded host. So everything is disallowed except ROBOTS_ALLOWED_PATHS; the
 * longest matching rule wins (RFC 9309), so those prefixes override
 * `Disallow: /`. There is no sitemap.
 *
 * The proxy matcher excludes this path (src/proxy.ts): before this file every
 * crawler's fetch went through updateSession() and was 307-bounced to /login.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: [...ROBOTS_ALLOWED_PATHS],
      disallow: '/',
    },
  }
}
