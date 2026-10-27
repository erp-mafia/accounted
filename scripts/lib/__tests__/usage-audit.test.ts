/**
 * The judging rules of the monthly usage audit (scripts/usage-audit.ts): an
 * observed path lands on the route that serves it, an item is unused only
 * when every source that can see it saw nothing, and a Vercel-only item needs
 * three monthly runs in a row before it is proposed for removal.
 */
import { describe, expect, it } from 'vitest'
import {
  isSingleCompany,
  isUnused,
  keptBy,
  matchRoute,
  routeMatcher,
  routePatternFromDir,
  runsNeeded,
  unusedStreak,
  type KeepEntry,
  type Snapshot,
} from '../usage-audit'

describe('routePatternFromDir', () => {
  it('drops route groups and parallel slots, which are not URL segments', () => {
    expect(routePatternFromDir('/(dashboard)/invoices/[id]')).toBe('/invoices/[id]')
    expect(routePatternFromDir('/(public)/invoice-action/[token]')).toBe('/invoice-action/[token]')
    expect(routePatternFromDir('/@modal/settings')).toBe('/settings')
    expect(routePatternFromDir('')).toBe('/')
  })
})

describe('matchRoute', () => {
  const matchers = ['/invoices/[id]', '/invoices/new', '/reports/[slug]', '/api/storage/[...path]', '/docs/[[...rest]]', '/']
    .map(routeMatcher)

  it('sends an id-collapsed path to its dynamic route', () => {
    expect(matchRoute('/invoices/*', matchers)).toBe('/invoices/[id]')
    expect(matchRoute('/reports/huvudbok', matchers)).toBe('/reports/[slug]')
  })

  it('prefers the static route when both match', () => {
    expect(matchRoute('/invoices/new', matchers)).toBe('/invoices/new')
  })

  it('handles catch-alls, optional catch-alls and the root', () => {
    expect(matchRoute('/api/storage/a/b/c', matchers)).toBe('/api/storage/[...path]')
    expect(matchRoute('/docs', matchers)).toBe('/docs/[[...rest]]')
    expect(matchRoute('/docs/a/b', matchers)).toBe('/docs/[[...rest]]')
    expect(matchRoute('/', matchers)).toBe('/')
  })

  it('reads extension route parameters', () => {
    const ext = [routeMatcher('/api/extensions/ext/invoice-inbox/items/:id/purchase-category')]
    expect(matchRoute('/api/extensions/ext/invoice-inbox/items/*/purchase-category', ext)).toBe(
      '/api/extensions/ext/invoice-inbox/items/:id/purchase-category',
    )
  })

  it('answers null for a path no route serves', () => {
    expect(matchRoute('/no/such/page', matchers)).toBeNull()
  })
})

describe('isUnused', () => {
  it('needs both PostHog and Vercel silent for a page', () => {
    expect(isUnused('page', {})).toBe(true)
    expect(isUnused('page', { posthogViews: 0, vercelHits: 3 })).toBe(false)
    expect(isUnused('page', { posthogViews: 2 })).toBe(false)
  })

  it('reads only the source that can see the item', () => {
    expect(isUnused('api', { posthogViews: 9 })).toBe(true)
    expect(isUnused('api', { vercelHits: 1 })).toBe(false)
    expect(isUnused('workspace', { vercelHits: 500 })).toBe(true)
    expect(isUnused('mcp', { mcpCalls: 1 })).toBe(false)
  })
})

describe('isSingleCompany', () => {
  it('flags pages and tools used by at most one company outside the internal ones', () => {
    expect(isSingleCompany('mcp', { mcpCalls: 14, companies: 1 })).toBe(true)
    expect(isSingleCompany('mcp', { mcpCalls: 1, companies: 0 })).toBe(true)
    expect(isSingleCompany('page', { posthogViews: 3, companies: 2 })).toBe(false)
  })

  it('never judges by Vercel hits alone, which carry no company', () => {
    expect(isSingleCompany('page', { vercelHits: 40 })).toBe(false)
    expect(isSingleCompany('api', { vercelHits: 40, companies: 1 })).toBe(false)
  })

  it('does not count an unused item', () => {
    expect(isSingleCompany('mcp', { mcpCalls: 0, companies: 0 })).toBe(false)
  })
})

describe('unusedStreak', () => {
  const previous: Snapshot[] = [
    { run: '2026-12', unused: { api: ['/api/a', '/api/b'] } },
    { run: '2026-11', unused: { api: ['/api/a'] } },
  ]

  it('counts this run and every earlier one in a row that found it unused', () => {
    expect(unusedStreak('api', '/api/a', previous)).toBe(3)
    expect(unusedStreak('api', '/api/b', previous)).toBe(2)
    expect(unusedStreak('api', '/api/c', previous)).toBe(1)
  })

  it('makes a Vercel-only item wait for three runs, the others judge on one', () => {
    expect(runsNeeded('api')).toBe(3)
    expect(runsNeeded('extension-route')).toBe(3)
    expect(runsNeeded('page')).toBe(1)
    expect(runsNeeded('mcp')).toBe(1)
  })
})

describe('keptBy', () => {
  const keep: KeepEntry[] = [
    { kind: 'api', match: '/api/v1/*', reason: 'public API contract' },
    { kind: 'mcp', match: 'gnubok_post_annual_depreciation', reason: 'seasonal', until: '2027-07-01' },
  ]

  it('matches an exact item or a prefix, only for its kind', () => {
    expect(keptBy('api', '/api/v1/companies/[companyId]/invoices', keep, '2026-11-01')?.reason).toBe('public API contract')
    expect(keptBy('page', '/api/v1/companies', keep, '2026-11-01')).toBeNull()
    expect(keptBy('mcp', 'gnubok_post_annual_depreciation', keep, '2026-11-01')?.reason).toBe('seasonal')
  })

  it('lets an entry lapse after its until date, so the item is judged again', () => {
    expect(keptBy('mcp', 'gnubok_post_annual_depreciation', keep, '2027-07-02')).toBeNull()
  })
})
