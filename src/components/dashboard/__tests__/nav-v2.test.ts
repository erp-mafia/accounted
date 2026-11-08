import { describe, expect, it } from 'vitest'
import { activeSubHref, isNavSectionExpanded, reportNavigationGroups } from '../nav-v2'
import { getLibrarySections } from '@/lib/reports/catalog'

describe('independent navigation disclosure', () => {
  it('opens active branches by default and lets the current branch be collapsed', () => {
    expect(isNavSectionExpanded(undefined, '/customers', true)).toBe(true)
    expect(isNavSectionExpanded(undefined, '/customers', false)).toBe(false)
    expect(isNavSectionExpanded({ open: false, pathname: '/customers' }, '/customers', true)).toBe(false)
  })

  it('preserves explicit opens across navigation and opens a newly active route', () => {
    expect(isNavSectionExpanded({ open: true, pathname: '/customers' }, '/articles', false)).toBe(true)
    expect(isNavSectionExpanded({ open: false, pathname: '/customers' }, '/articles', true)).toBe(true)
    expect(isNavSectionExpanded({ open: false, pathname: '/customers' }, '/articles', false)).toBe(false)
  })

  it('finds the longest active destination inside report categories', () => {
    const reports = {
      href: '/reports', labelKey: 'reports',
      sub: [{ href: '/reports', labelKey: 'reports_overview' }],
      groups: reportNavigationGroups('aktiebolag', true, true),
    }
    expect(activeSubHref(reports, href => '/reports/huvudbok'.startsWith(href))).toBe('/reports/huvudbok')
    expect(activeSubHref(reports, href => href === '/kpi')).toBe('/kpi')
    expect(activeSubHref(reports, href => href === '/customers')).toBeNull()
  })
})

describe('nested report destinations', () => {
  it('reuses the complete catalog including its existing routes and labels', () => {
    const groups = reportNavigationGroups('aktiebolag', true, true)
    const sections = getLibrarySections('aktiebolag', true, true)
    expect(groups.map(group => group.id)).toEqual(sections.map(section => section.category))
    expect(groups.flatMap(group => group.items.map(item => item.href))).toEqual(
      sections.flatMap(section => section.items.map(report => report.route ?? `/reports/${report.slug}`)),
    )
    expect(groups.every(group => group.labelNamespace === 'reports')).toBe(true)
  })

  it('preserves company-form, employee and dimension visibility', () => {
    const groups = reportNavigationGroups('enskild_firma', false, false)
    const hrefs = groups.flatMap(group => group.items.map(item => item.href))
    expect(hrefs).toContain('/reports/ne-declaration')
    expect(hrefs).not.toContain('/reports/ink2-declaration')
    expect(hrefs).not.toContain('/reports/dimension-pnl')
    expect(hrefs).not.toContain('/reports/semesterskuld')
  })
})
