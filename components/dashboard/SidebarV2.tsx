'use client'

import type { ReactNode } from 'react'
import { NavLink } from './NavLink'
import { cn } from '@/lib/utils'
import { activeSubHref, type NavV2Item } from './nav-v2'

interface SidebarV2Props {
  top: NavV2Item[]
  company: NavV2Item[]
  bottom: NavV2Item[]
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
  switcher: ReactNode
  /** Byrå members inside a company: the pinned route back to the cockpit. */
  backLink?: ReactNode
  userBlock: ReactNode
}

/**
 * Shell v2 desktop sidebar (dev_docs/ui_v2_build_plan.md, PR 2): 220px,
 * brand and company chip on top, Att göra and Assistent, then the BOLAGET
 * sections. The active section shows its sub-items underneath; the rest
 * stay one line each. No collapse: the prototype has none and the panel
 * is full-bleed anyway. Mobile keeps the v1 bottom nav (DashboardNav).
 */
export function SidebarV2({
  top,
  company,
  bottom,
  groupLabel,
  label,
  isActive,
  isEnabled,
  badgeFor,
  needsCompanyTitle,
  betaLabel,
  mainNavLabel,
  brand,
  switcher,
  backLink,
  userBlock,
}: SidebarV2Props) {
  const countBubble = (n: number) => (
    <span
      data-ph-mask
      className="ml-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground"
    >
      {n > 99 ? '99+' : n}
    </span>
  )

  const row = (item: NavV2Item, active: boolean, opts?: { sub?: boolean }) => {
    const enabled = isEnabled(item.href) && !item.comingSoon
    const badge = badgeFor(item.href)
    const Icon = item.icon
    const content = (
      <>
        {!opts?.sub && Icon && (
          <Icon
            className={cn(
              'mr-2.5 h-[15px] w-[15px] flex-shrink-0',
              active ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground',
            )}
          />
        )}
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
      <NavLink key={item.href} href={item.href} className={baseClass}>
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
    return (
      <div key={item.href}>
        {row(item, active)}
        {active && subs.length > 0 && (
          <div className="ml-[19px] mt-px border-l border-border pl-1.5 py-px space-y-px">
            {subs.map((s) => row(s, s.href === activeSub, { sub: true }))}
          </div>
        )}
      </div>
    )
  }

  return (
    <aside className="hidden md:fixed md:inset-y-0 md:z-10 md:flex md:w-[var(--nav-w)] md:flex-col">
      <div className="flex min-h-0 flex-1 flex-col bg-transparent">
        <div className="flex flex-shrink-0 items-center justify-between pl-5 pr-3 pt-3 pb-1">{brand}</div>
        <div className="flex-shrink-0 px-3 pb-2">{switcher}</div>
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
        <div className="flex-shrink-0 space-y-px px-3 pb-1">{bottom.map((item) => row(item, isActive(item.href)))}</div>
        {userBlock}
      </div>
    </aside>
  )
}
