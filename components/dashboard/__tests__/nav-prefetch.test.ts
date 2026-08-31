import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { shouldWarmNavRoute } from '../nav-prefetch'

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

describe('DashboardNav uses NavLink for every link', () => {
  it('has no bare next/link usage left, so no nav link prefetches on viewport', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'DashboardNav.tsx'), 'utf8')
    expect(source).not.toMatch(/from 'next\/link'/)
    expect(source).not.toMatch(/<Link[\s>]/)
    expect(source).toMatch(/<NavLink[\s>]/)
  })
})
