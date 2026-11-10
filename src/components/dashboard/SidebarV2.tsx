'use client'

import type { ReactNode } from 'react'
import { NavTreeSection } from './NavTreeSection'
import type { NavV2Item } from './nav-v2'

interface SidebarV2Props {
  top: NavV2Item[]
  company: NavV2Item[]
  /** BOLAGET group header; empty string hides the group (cockpit mode). */
  groupLabel: string
  label: (labelKey: string, namespace?: 'reports') => string
  toggleLabel: (name: string, expanded: boolean) => string
  isActive: (href: string) => boolean
  isEnabled: (href: string) => boolean
  badgeFor: (href: string) => number | null
  needsCompanyTitle: string
  betaLabel: string
  mainNavLabel: string
  brand: ReactNode
  /** Byrå members inside a company: the pinned route back to the cockpit. */
  backLink?: ReactNode
  userBlock: ReactNode
  /** The icon for a row; the nav uses it to show the agent's own face on Assistent. */
  renderIcon?: (item: NavV2Item, className: string) => ReactNode
}

/**
 * Desktop sidebar (UI v2 PR 2, the default since PR #2390): 220px,
 * brand on top, Att göra and Assistent, then the BOLAGET sections, and the
 * user block at the bottom. Settings, help and the company switcher are in
 * the user menu, so nothing else sits below the sections (founder call
 * 2026-09-07). Disclosure buttons open each section independently. Active branches
 * also open when the route changes, and report categories nest underneath. Mobile
 * keeps the bottom nav (DashboardNav).
 */
export function SidebarV2({
  top,
  company,
  groupLabel,
  label,
  toggleLabel,
  isActive,
  isEnabled,
  badgeFor,
  needsCompanyTitle,
  betaLabel,
  mainNavLabel,
  brand,
  backLink,
  userBlock,
  renderIcon,
}: SidebarV2Props) {
  const section = (item: NavV2Item) => (
    <NavTreeSection
      key={item.href}
      item={item}
      label={label}
      toggleLabel={toggleLabel}
      isActive={isActive}
      isEnabled={isEnabled}
      badgeFor={badgeFor}
      needsCompanyTitle={needsCompanyTitle}
      betaLabel={betaLabel}
      renderIcon={renderIcon}
    />
  )

  return (
    <aside className="hidden md:fixed md:inset-y-0 md:z-10 md:flex md:w-[var(--nav-w)] md:flex-col">
      <div className="flex min-h-0 flex-1 flex-col bg-transparent">
        <div className="flex flex-shrink-0 items-center justify-between pl-5 pr-3 pt-3 pb-2">{brand}</div>
        <nav
          data-ph-unmask
          aria-label={mainNavLabel}
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pt-1 pb-2"
        >
          {backLink}
          <div className="mb-4 space-y-px">{top.map(section)}</div>
          {company.length > 0 && (
            <div className="mb-4">
              {groupLabel && (
                <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  {groupLabel}
                </div>
              )}
              <div className="space-y-px">{company.map(section)}</div>
            </div>
          )}
        </nav>
        {userBlock}
      </div>
    </aside>
  )
}
