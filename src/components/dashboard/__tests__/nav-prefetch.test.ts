import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { isCurrentPageHref, shouldWarmNavRoute } from '../nav-prefetch'

describe('shouldWarmNavRoute', () => {
  it('warms other internal routes, ignoring query and hash', () => {
    expect(shouldWarmNavRoute('/invoices', '/transactions')).toBe(true)
    expect(shouldWarmNavRoute('/invoices?status=draft', '/transactions')).toBe(true)
    expect(shouldWarmNavRoute('/reports#top', '/transactions')).toBe(true)
  })

  it('does not warm the current route or non-routes', () => {
    expect(shouldWarmNavRoute('/invoices', '/invoices')).toBe(false)
    expect(shouldWarmNavRoute('/invoices?x=1', '/invoices')).toBe(false)
    expect(shouldWarmNavRoute('https://example.com', '/')).toBe(false)
    expect(shouldWarmNavRoute('//evil.example', '/')).toBe(false)
    expect(shouldWarmNavRoute('#section', '/')).toBe(false)
  })

  it('warms when the pathname is unknown (first render)', () => {
    expect(shouldWarmNavRoute('/invoices', null)).toBe(true)
  })
})

describe('isCurrentPageHref', () => {
  it('is true for the link to the page already showing', () => {
    // Att göra ("/") clicked while on Att göra: refresh instead of a cached no-op.
    expect(isCurrentPageHref('/', '/', '')).toBe(true)
    expect(isCurrentPageHref('/transactions', '/transactions', '')).toBe(true)
    expect(isCurrentPageHref('/invoices?status=overdue', '/invoices', '?status=overdue')).toBe(true)
  })

  it('stays a navigation when the path or the query differs', () => {
    expect(isCurrentPageHref('/pending', '/', '')).toBe(false)
    // Clearing a filter by clicking the plain nav link must still navigate.
    expect(isCurrentPageHref('/transactions', '/transactions', '?source=skatteverket')).toBe(false)
    expect(isCurrentPageHref('/invoices?status=draft', '/invoices', '')).toBe(false)
  })

  it('is false for non-routes and hash links', () => {
    expect(isCurrentPageHref('https://example.com/', '/', '')).toBe(false)
    expect(isCurrentPageHref('//evil.example', '/', '')).toBe(false)
    expect(isCurrentPageHref('/reports#top', '/reports', '')).toBe(false)
    expect(isCurrentPageHref('#section', '/', '')).toBe(false)
  })
})

describe('NavLink refreshes the page already showing', () => {
  it('handles plain clicks on the current page with router.refresh, keeping a caller onClick', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'NavLink.tsx'), 'utf8')
    expect(source).toMatch(/onClick\?\.\(e\)/)
    expect(source).toMatch(/isCurrentPageHref\(href, window\.location\.pathname, window\.location\.search\)/)
    expect(source).toMatch(/router\.refresh\(\)/)
  })
})

describe('DashboardNav uses NavLink for every link', () => {
  it('has no bare next/link usage left, so no nav link prefetches on viewport', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'DashboardNav.tsx'), 'utf8')
    expect(source).not.toMatch(/from 'next\/link'/)
    expect(source).not.toMatch(/<Link[\s>]/)
    expect(source).toMatch(/<NavLink[\s>]/)
  })
})
