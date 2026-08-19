import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const NAV_SRC = fs.readFileSync(
  path.resolve(__dirname, '../DashboardNav.tsx'),
  'utf8',
)
const USER_MENU_SRC = fs.readFileSync(
  path.resolve(__dirname, '../UserMenu.tsx'),
  'utf8',
)

/**
 * Regression pin for one-click company switching in the sidebar (#1664).
 *
 * The switch was folded into the bottom-of-sidebar user popover as a nested
 * flyout (avatar, then "Byt foretag", then the company): three clicks per
 * switch, which consultants who hop between companies do constantly. The
 * one-click CompanySwitcher must stay mounted at the top of the desktop
 * sidebar, with the user-menu flyout as the secondary path. The repo does
 * not render components in tests, so pin the source shape instead, the same
 * way JournalEntryList's copy affordance is pinned.
 */
describe('DashboardNav sidebar company switcher (#1664)', () => {
  const asideStart = NAV_SRC.indexOf('<aside')
  const mobileNavStart = NAV_SRC.indexOf('Mobile bottom navigation')
  // Unique to the desktop nav scroll container; the mobile sheet uses
  // overscroll-contain instead.
  const desktopScrollStart = NAV_SRC.indexOf('overflow-y-auto overflow-x-hidden')

  it('has the anchors this pin relies on', () => {
    expect(asideStart).toBeGreaterThan(-1)
    expect(mobileNavStart).toBeGreaterThan(asideStart)
    expect(desktopScrollStart).toBeGreaterThan(asideStart)
    expect(desktopScrollStart).toBeLessThan(mobileNavStart)
  })

  it('renders CompanySwitcher inside the desktop sidebar, not only the mobile sheet', () => {
    const desktopSwitcher = NAV_SRC.indexOf('<CompanySwitcher />', asideStart)
    expect(desktopSwitcher).toBeGreaterThan(asideStart)
    expect(desktopSwitcher).toBeLessThan(mobileNavStart)
  })

  it('pins the desktop switcher to the top of the sidebar, above the nav scroll container', () => {
    const desktopSwitcher = NAV_SRC.indexOf('<CompanySwitcher />', asideStart)
    expect(desktopSwitcher).toBeLessThan(desktopScrollStart)
  })

  it('keeps the mobile sheet switcher as well', () => {
    const desktopSwitcher = NAV_SRC.indexOf('<CompanySwitcher />', asideStart)
    const mobileSwitcher = NAV_SRC.indexOf('<CompanySwitcher />', mobileNavStart)
    expect(mobileSwitcher).toBeGreaterThan(desktopSwitcher)
  })

  it('labels the brand logo link with a visible title tooltip and aria-label', () => {
    const logoLink = NAV_SRC.slice(
      NAV_SRC.indexOf('<Link', asideStart),
      NAV_SRC.indexOf('</Link>', asideStart),
    )
    expect(logoLink).toContain('aria-label={getBranding().appName}')
    expect(logoLink).toContain('title={getBranding().appName}')
  })

  it('keeps the user-menu company flyout as the secondary switch path', () => {
    expect(USER_MENU_SRC).toContain('performCompanySwitch')
    expect(USER_MENU_SRC).toContain('setCompaniesOpen')
  })
})
