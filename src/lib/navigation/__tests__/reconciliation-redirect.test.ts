import { describe, expect, it } from 'vitest'
import nextConfig from '../../../../next.config'
import { NAV_V2_COMPANY, NAV_V2_TOP, type NavV2Item } from '@/components/dashboard/nav-v2'
import { navItems } from '@/components/dashboard/nav-phone'

/**
 * Konton is the one account list (founder decision 2026-10-18): the
 * Avstämning list left the menu, and its address keeps working for the
 * bookmarks, Att göra rows, notices and checklist links that carry it. The
 * bare /reconciliation lands on Konton with its query string; with ?account=
 * it still opens that account's reconciliation.
 */

async function redirectRules() {
  expect(nextConfig.redirects).toBeTypeOf('function')
  return nextConfig.redirects!()
}

describe('/reconciliation after the Konton merge', () => {
  it('redirects the bare address to Konton, temporarily, unless an account is named', async () => {
    const rules = (await redirectRules()).filter((rule) => rule.source === '/reconciliation')
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({
      destination: '/accounts',
      permanent: false,
      missing: [{ type: 'query', key: 'account' }],
    })
    // No `has` condition: every bare visit redirects, ?autorun=1 included
    // (Next forwards the query string to the destination).
    expect('has' in rules[0] && rules[0].has).toBeFalsy()
  })

  it('keeps one Konton entry in both menus and no Avstämning list entry', () => {
    const sidebar = (items: NavV2Item[]) => items.flatMap((item) => [item.href, ...(item.sub ?? []).map((s) => s.href)])
    const desktop = sidebar([...NAV_V2_TOP, ...NAV_V2_COMPANY])
    const phone = navItems.map((item) => item.href)
    for (const hrefs of [desktop, phone]) {
      expect(hrefs.filter((href) => href === '/accounts')).toHaveLength(1)
      expect(hrefs).not.toContain('/reconciliation')
    }
  })
})
