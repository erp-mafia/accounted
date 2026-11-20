/**
 * The docs sidebar against the pages that exist.
 *
 * The sidebar used to keep its own list of reference pages and listed 23 of
 * the 51: the other 28 (bank payments, collections, fixed assets, budgets,
 * pending operations, ...) could only be reached from the overview page. The
 * reference sections are now built from RESOURCES, and these tests hold the
 * rest of the sidebar to the routes behind it.
 */
import { existsSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { COOKBOOK_SLUGS } from '../content/cookbook'
import { RESOURCES, RESOURCE_NAV_GROUPS } from '../content/reference-resources'
import { DOCS_NAV, FEATURED_REFERENCE_LINKS } from '../nav'

const DOCS_APP_DIR = path.resolve(__dirname, '../../../app/docs/api')
const REFERENCE_PREFIX = '/docs/api/reference/'
const COOKBOOK_PREFIX = '/docs/api/cookbook/'

const allLinks = DOCS_NAV.flatMap((section) => section.links)

function stripFragment(href: string): string {
  const hash = href.indexOf('#')
  return hash === -1 ? href : href.slice(0, hash)
}

describe('docs sidebar', () => {
  it('links every reference page exactly once', () => {
    const linked = allLinks.map((l) => l.href).filter((href) => href.startsWith(REFERENCE_PREFIX))
    const expected = RESOURCES.map((r) => `${REFERENCE_PREFIX}${r.slug}`)
    expect([...linked].sort()).toEqual([...expected].sort())
  })

  it('shows a section for every reference group, each with pages', () => {
    for (const group of RESOURCE_NAV_GROUPS) {
      const section = DOCS_NAV.find((s) => s.label === group)
      expect(section, group).toBeDefined()
      expect(section!.links.length, group).toBeGreaterThan(0)
    }
  })

  it('names every section once (the sidebar keys its sections by label)', () => {
    const labels = DOCS_NAV.map((s) => s.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('points every docs link at a page that exists', () => {
    const dead: string[] = []
    for (const link of allLinks) {
      const href = stripFragment(link.href)
      if (!href.startsWith('/docs/api')) continue
      if (href.startsWith(REFERENCE_PREFIX)) {
        if (!RESOURCES.some((r) => r.slug === href.slice(REFERENCE_PREFIX.length))) dead.push(link.href)
      } else if (href.startsWith(COOKBOOK_PREFIX)) {
        if (!COOKBOOK_SLUGS.includes(href.slice(COOKBOOK_PREFIX.length))) dead.push(link.href)
      } else {
        const relative = href.slice('/docs/api'.length)
        if (!existsSync(path.join(DOCS_APP_DIR, relative, 'page.tsx'))) dead.push(link.href)
      }
    }
    expect(dead).toEqual([])
  })

  it('features only reference pages that exist on the landing page', () => {
    expect(FEATURED_REFERENCE_LINKS.length).toBeGreaterThan(0)
    for (const link of FEATURED_REFERENCE_LINKS) {
      expect(RESOURCES.some((r) => `${REFERENCE_PREFIX}${r.slug}` === link.href), link.href).toBe(true)
    }
  })
})
