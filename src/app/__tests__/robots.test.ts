import { describe, expect, it } from 'vitest'
import { resolveRobots } from 'next/dist/build/webpack/loaders/metadata/resolve-route-data'
import { parseRobots, robotsAllows } from '@/lib/vendor-logos/robots'
import robots from '../robots'

/**
 * /robots.txt (app/robots.ts): disallow the signed-in app and every token
 * link, allow only the anonymous agent-discovery surfaces llms.txt points at.
 * Before the file existed the proxy 307-bounced every crawler's fetch to
 * /login.
 */

/** The file exactly as Next.js serves it. */
const served = resolveRobots(robots())

/**
 * Whether a generic crawler may fetch `path`, read with the repo's own
 * RFC 9309 parser (longest match wins, Allow on a tie). The product token
 * names no group in the file, so the `*` group applies.
 */
function allowedByRobots(text: string, path: string): boolean {
  return robotsAllows(parseRobots(text, 'examplebot'), path)
}

describe('robots.txt', () => {
  it('is one group for every crawler: the discovery surfaces, then Disallow: /', () => {
    expect(served).toBe(
      [
        'User-Agent: *',
        'Allow: /llms.txt',
        'Allow: /llms-full.txt',
        'Allow: /docs',
        'Allow: /api/v1/openapi.json',
        'Allow: /.well-known/',
        'Disallow: /',
        '',
        '',
      ].join('\n'),
    )
  })

  it('advertises no sitemap and no host', () => {
    expect(served).not.toMatch(/^(Sitemap|Host):/m)
  })

  it.each([
    '/llms.txt',
    '/llms-full.txt',
    '/docs/api',
    '/docs/api.md',
    '/api/v1/openapi.json',
    '/.well-known/skills/index.json',
    '/.well-known/oauth-authorization-server',
  ])('lets crawlers fetch the discovery surface %s', (path) => {
    expect(allowedByRobots(served, path)).toBe(true)
  })

  it.each([
    '/',
    '/login',
    '/register',
    '/invoices',
    '/settings/api',
    '/invite/6f1c2a3e-token',
    '/payslip/6f1c2a3e-token',
    '/koppla/6f1c2a3e-token',
    '/betala/6f1c2a3e-token',
    '/attest/6f1c2a3e-token',
    '/invoice-action/6f1c2a3e-token',
    '/reset-password',
    '/auth/callback',
    '/sandbox',
    '/terms',
    '/api/v1/companies',
    '/api/extensions/ext/mcp-server/mcp',
  ])('keeps crawlers out of %s', (path) => {
    expect(allowedByRobots(served, path)).toBe(false)
  })
})
