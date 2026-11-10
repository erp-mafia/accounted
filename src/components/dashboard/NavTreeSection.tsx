'use client'

import { useId, useState, type ReactNode } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { NavLink } from './NavLink'
import { Button } from '@/components/ui/button'
import { activeSubHref, isNavSectionExpanded, type NavExpansion, type NavV2Item } from './nav-v2'
import { cn } from '@/lib/utils'

export interface NavTreeSectionProps {
  item: NavV2Item
  label: (key: string, namespace?: 'reports') => string
  toggleLabel: (name: string, expanded: boolean) => string
  isActive: (href: string) => boolean
  isEnabled: (href: string) => boolean
  badgeFor: (href: string) => number | null
  needsCompanyTitle: string
  betaLabel: string
  renderIcon?: (item: NavV2Item, className: string) => ReactNode
  onNavigate?: () => void
  mobile?: boolean
}

/** Separate disclosure controls preserve each section's normal destination. */
export function NavTreeSection({
  item, label, toggleLabel, isActive, isEnabled, badgeFor,
  needsCompanyTitle, betaLabel, renderIcon, onNavigate, mobile = false,
}: NavTreeSectionProps) {
  const pathname = usePathname() ?? ''
  const searchParams = useSearchParams()
  const id = useId()
  const [expansion, setExpansion] = useState<Record<string, NavExpansion>>({})
  const selected = activeSubHref(item, href => {
    const [targetPath, query] = href.split('#')[0].split('?')
    return isActive(targetPath) && [...new URLSearchParams(query)].every(([key, value]) => searchParams.get(key) === value)
  })
  const active = isActive(item.href) || selected !== null
  const open = isNavSectionExpanded(expansion[item.href], pathname, active)
  const groups = item.groups ?? []
  const children = item.sub ?? []
  const hasChildren = children.length > 0 || groups.length > 0
  const name = label(item.labelKey, item.labelNamespace)
  const panelId = `${id}-children`

  /** Toggle one branch while retaining the route associated with an explicit collapse. */
  function toggle(key: string, branchActive: boolean) {
    setExpansion(previous => ({
      ...previous,
      [key]: { open: !isNavSectionExpanded(previous[key], pathname, branchActive), pathname },
    }))
  }

  /** Render a destination with its visibility gate, selection state and shared link behavior. */
  function row(entry: NavV2Item, rowActive: boolean, sub = false) {
    const enabled = isEnabled(entry.href) && !entry.comingSoon
    const badge = badgeFor(entry.href)
    const Icon = entry.icon
    const iconClass = cn('mr-2.5 shrink-0', mobile ? 'h-[18px] w-[18px]' : 'h-[15px] w-[15px]', rowActive ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground')
    const content = <>
      {!sub && Icon && (renderIcon ? renderIcon(entry, iconClass) : <Icon className={iconClass} />)}
      <span className="min-w-0 flex-1 truncate">{label(entry.labelKey, entry.labelNamespace)}</span>
      {entry.betaBadge ? (
        <span className="ml-auto rounded-full bg-muted/60 px-1.5 py-0.5 text-[11px] uppercase tracking-wider text-muted-foreground/70">{betaLabel}</span>
      ) : badge !== null && (
        <span data-ph-mask className="ml-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[11px] font-semibold text-primary-foreground">{badge > 99 ? '99+' : badge}</span>
      )}
    </>
    const className = cn(
      'group flex min-w-0 flex-1 items-center rounded-lg px-3 transition-colors duration-150',
      sub ? 'py-[5px] text-[12.5px]' : 'min-h-10 py-[7px] text-[13px]',
      mobile && 'min-h-[44px] text-sm',
      enabled ? rowActive ? 'bg-secondary text-foreground font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60' : 'text-muted-foreground/40 cursor-not-allowed',
    )
    return enabled ? (
      <NavLink key={entry.href} href={entry.href} className={className} onClick={onNavigate} aria-current={rowActive && (sub || selected === null) ? 'page' : undefined}>{content}</NavLink>
    ) : (
      <div key={entry.href} className={className} aria-disabled="true" title={needsCompanyTitle}>{content}</div>
    )
  }

  return <div>
    <div className="flex min-w-0 items-center gap-0.5">
      {row(item, active)}
      {hasChildren && <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0 text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={toggleLabel(name, open)}
        onClick={() => toggle(item.href, active)}
      >
        <ChevronRight className={cn('h-[15px] w-[15px] transition-transform duration-150', open && 'rotate-90')} aria-hidden />
      </Button>}
    </div>
    {hasChildren && <div
      id={panelId}
      className={cn('grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none', open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}
      aria-hidden={!open}
      inert={!open}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="ml-[19px] mt-px space-y-px border-l border-border py-px pl-1.5">
          {children.map(child => row(child, child.href === selected, true))}
          {groups.map(group => {
            const key = `${item.href}:${group.id}`
            const groupActive = group.items.some(child => child.href === selected)
            const groupOpen = isNavSectionExpanded(expansion[key], pathname, groupActive)
            const groupName = label(group.labelKey, group.labelNamespace)
            const groupPanelId = `${id}-${group.id}`
            return <div key={group.id}>
              <Button
                type="button"
                variant="ghost"
                size={mobile ? 'lg' : 'default'}
                className="w-full justify-start gap-2 px-3 text-left font-normal text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                aria-expanded={groupOpen}
                aria-controls={groupPanelId}
                aria-label={toggleLabel(groupName, groupOpen)}
                onClick={() => toggle(key, groupActive)}
              >
                <span className="min-w-0 flex-1 truncate">{groupName}</span>
                <ChevronRight className={cn('h-[15px] w-[15px] shrink-0 transition-transform duration-150', groupOpen && 'rotate-90')} aria-hidden />
              </Button>
              <div id={groupPanelId} hidden={!groupOpen} inert={!groupOpen}>
                <div className="ml-3 space-y-px border-l border-border pl-1.5">
                  {group.items.map(child => row(child, child.href === selected, true))}
                </div>
              </div>
            </div>
          })}
        </div>
      </div>
    </div>}
  </div>
}
