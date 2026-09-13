'use client'

import type { ReactNode } from 'react'
import { NavLink } from './NavLink'
import { cn } from '@/lib/utils'
import { activeSubHref, type NavV2Item } from './nav-v2'

interface SidebarV2Props {
  top: NavV2Item[]
  company: NavV2Item[]
  /** BOLAGET group header; empty string hides the group (cockpit mode). */
  groupLabel: string
  label: (labelKey: string) => string
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
 * Shell v2 desktop sidebar (dev_docs/ui_v2_build_plan.md, PR 2): 220px,
 * brand on top, Att göra and Assistent, then the BOLAGET sections, and the
 * user block at the bottom. Settings, help and the company switcher are in
 * the user menu, so nothing else sits below the sections (founder call
 * 2026-09-07). The active section shows its sub-items underneath, folding
 * open with a short height transition; the rest stay one line each. Mobile
 * keeps the v1 bottom nav (DashboardNav).
 */
export function SidebarV2({
  top,
  company,
  groupLabel,
  label,
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
  const countBubble = (n: number) => (
    <span
      data-ph-mask
      className="ml-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground"
    >
      {n > 99 ? '99+' : n}
    </span>
  )

  const row = (item: NavV2Item, active: boolean, opts?: { sub?: boolean; hidden?: boolean }) => {
    const enabled = isEnabled(item.href) && !item.comingSoon
    const badge = badgeFor(item.href)
    const Icon = item.icon
    const iconClass = cn(
      'mr-2.5 h-[15px] w-[15px] flex-shrink-0',
      active ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground',
    )
    const content = (
      <>
        {!opts?.sub && Icon && (renderIcon ? renderIcon(item, iconClass) : <Icon className={iconClass} />)}
        <span className="flex-1 truncate">{label(item.labelKey)}</span>
        {item.betaBadge ? (
          <span className="ml-auto rounded-full bg-muted/60 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-muted-foreground/70">
            {betaLabel}
          </span>
        ) : (
          badge !== null && countBubble(badge)
        )}
      </>
    )
    const baseClass = cn(
      'group flex items-center rounded-lg',
      opts?.sub ? 'px-3 py-[5px] text-[12.5px]' : 'px-3 py-[7px] text-[13px]',
      enabled
        ? cn(
            'transition-colors duration-150',
            active
              ? 'bg-secondary text-foreground font-medium'
              : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60',
          )
        : 'text-muted-foreground/40 cursor-not-allowed',
    )
    return enabled ? (
      <NavLink key={item.href} href={item.href} className={baseClass} tabIndex={opts?.hidden ? -1 : undefined}>
        {content}
      </NavLink>
    ) : (
      <div key={item.href} className={baseClass} aria-disabled="true" title={needsCompanyTitle}>
        {content}
      </div>
    )
  }

  const section = (item: NavV2Item) => {
    const subs = item.sub ?? []
    const activeSub = activeSubHref(item, isActive)
    const active = isActive(item.href) || activeSub !== null
    // The sub-list is always in the tree and folds through grid-template-rows,
    // so a section opening slides instead of jumping (motion-safe only).
    return (
      <div key={item.href}>
        {row(item, active)}
        {subs.length > 0 && (
          <div
            className={cn(
              'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
              active ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
            )}
            aria-hidden={!active}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="ml-[19px] mt-px border-l border-border pl-1.5 py-px space-y-px">
                {subs.map((s) => row(s, s.href === activeSub, { sub: true, hidden: !active }))}
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

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
                <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
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
