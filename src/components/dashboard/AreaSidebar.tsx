'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { NavLink } from './NavLink'
import { Button } from '@/components/ui/button'
import { ArrowUpTrayIcon, ChevronRightIcon, Cog6ToothIcon, PlusIcon } from '@/components/icons'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/count-tile'
import { cn } from '@/lib/utils'
import { openCommandPalette } from '@/components/common/open-command-palette'
import { NAV_GROUP_LABEL_CLASS, NAV_ROW_ICON_CLASS, navRowClass } from './nav-row-class'

export interface AreaRow {
  href: string
  label: string
  icon: ReactNode
  active: boolean
  enabled: boolean
  /** Waiting work, only on the rows design convention 18 allows. */
  count: number | null
  /** "Beta" or "Ny" at the row's end. */
  tag?: string
}

export interface AreaRowGroup {
  key: string
  label?: string
  rows: AreaRow[]
}

interface AreaSidebarProps {
  /** A branded host's own mark (often a wide wordmark), heading the sidebar; unbranded hosts show no mark in the shell. */
  brand?: ReactNode
  /** The area's name: the sidebar's heading and its landmark label. */
  areaLabel: string
  /**
   * The row that heads the sidebar: the company switcher (initials tile,
   * name, fiscal year, up-down chevron), or in the byrå cockpit, which is
   * above the companies, the byrå's own name.
   */
  companyRow: ReactNode
  /** The area's create action: a link to the existing create route, or a handler that opens the existing dialog. */
  create?: { label: string; symbol?: 'upload'; href?: string; onClick?: () => void }
  groups: AreaRowGroup[]
  /** The area's settings pages, behind the one Inställningar row under the menu. */
  settingsLabel: string
  settingsLinks: { href: string; label: string }[]
  /** Replaces the rows: the Inställningar area draws the settings sections, a nav landmark of its own. */
  children?: ReactNode
  disabledTitle: string
  userBlock: ReactNode
}

/**
 * The area sidebar (V7 shell), the left column of the page panel: the
 * company row on top, the area's name, its create button, its rows, one
 * Inställningar row for the area's settings pages, and the user block at the
 * foot. One sidebar per area; the rail beside the panel switches between
 * them. Metrics: 10px side
 * padding, 30px rows with a 16px icon and a 10px gap, a 44px title row.
 */
export function AreaSidebar({
  brand,
  areaLabel,
  companyRow,
  create,
  groups,
  settingsLabel,
  settingsLinks,
  children,
  disabledTitle,
  userBlock,
}: AreaSidebarProps) {
  const row = (item: AreaRow) => {
    const content = (
      <>
        {item.icon}
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {item.tag ? (
          <span className="rounded-sm bg-secondary/80 px-1.5 text-xs font-medium leading-4 text-muted-foreground">{item.tag}</span>
        ) : (
          item.count !== null && (
            // A quiet number, not a bubble. data-ph-mask: a count is company data inside the unmasked nav.
            <span data-ph-mask className="text-[12px] tabular-nums text-muted-foreground">
              {item.count > 999 ? '999+' : item.count}
            </span>
          )
        )}
      </>
    )
    return (
      <li key={item.href}>
        {item.enabled ? (
          <NavLink href={item.href} aria-current={item.active ? 'page' : undefined} className={navRowClass(item.active)}>
            {content}
          </NavLink>
        ) : (
          <div className={navRowClass(false, { disabled: true })} aria-disabled="true" title={disabledTitle}>
            {content}
          </div>
        )}
      </li>
    )
  }

  const CreateSymbol = create?.symbol === 'upload' ? ArrowUpTrayIcon : PlusIcon
  const createContent = create && (
    <>
      <CreateSymbol className="h-3.5 w-3.5 text-foreground/70" />
      {create.label}
    </>
  )

  return (
    <aside
      data-shell-sidebar=""
      className="hidden min-h-0 w-[var(--side-w)] flex-shrink-0 flex-col border-r-hairline md:flex"
    >
      {brand && <div className="flex h-10 flex-shrink-0 items-center px-4 pt-2.5">{brand}</div>}
      <div className="flex-shrink-0 px-2.5 pt-2.5">{companyRow}</div>
      <div data-ph-unmask className="flex h-11 flex-shrink-0 items-center justify-between pl-4 pr-2.5">
        <h2 className="text-[15px] font-semibold text-strong">{areaLabel}</h2>
        <PaletteHint />
      </div>
      {create && (
        <div data-ph-unmask className="flex-shrink-0 px-2.5 pb-2">
          {create.href ? (
            <Button asChild variant="outline" className="w-full justify-start">
              <NavLink href={create.href}>{createContent}</NavLink>
            </Button>
          ) : (
            <Button variant="outline" className="w-full justify-start" onClick={create.onClick}>
              {createContent}
            </Button>
          )}
        </div>
      )}
      <div data-ph-unmask data-sidebar-menu="" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2.5 pb-4 pt-0.5">
        {children ?? (
          <nav aria-label={areaLabel}>
            {groups.map((group, index) => (
              <div key={group.key} className={index > 0 && group.label ? 'pt-3.5' : undefined}>
                {group.label && <p className={NAV_GROUP_LABEL_CLASS}>{group.label}</p>}
                <ul>{group.rows.map(row)}</ul>
              </div>
            ))}
          </nav>
        )}
        {settingsLinks.length > 0 && <AreaSettingsRow label={settingsLabel} links={settingsLinks} />}
      </div>
      {userBlock}
    </aside>
  )
}

/**
 * The one Inställningar row under an area's menu (the prototype's row: a gear,
 * "Inställningar", the first settings page's name and a chevron). With one
 * page it is a link to it; with several it opens a small menu of them.
 */
function AreaSettingsRow({ label, links }: { label: string; links: { href: string; label: string }[] }) {
  const content = (
    <>
      <Cog6ToothIcon className={NAV_ROW_ICON_CLASS} />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <span className="min-w-0 flex-shrink truncate text-[12px]">{links[0].label}</span>
      <ChevronRightIcon className="h-3 w-3 flex-shrink-0 opacity-60" />
    </>
  )
  const className = cn(navRowClass(false, { quiet: true }), 'mt-3 w-full')
  if (links.length === 1) {
    return (
      <NavLink href={links[0].href} className={className}>
        {content}
      </NavLink>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(className, 'data-[state=open]:bg-secondary/60 data-[state=open]:text-foreground')}>
          {content}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" sideOffset={6} className="min-w-48">
        {links.map((link) => (
          <DropdownMenuItem key={link.href} asChild>
            <NavLink href={link.href}>{link.label}</NavLink>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The quiet key hint beside the area name: it says the shortcut and opens the
 * command palette on a click.
 */
function PaletteHint() {
  const t = useTranslations('nav')
  return (
    <button
      type="button"
      aria-label={t('v3_palette_open')}
      title={t('v3_palette_open')}
      onClick={openCommandPalette}
      className="flex h-6 items-center gap-0.5 rounded-md px-1 transition-colors duration-150 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 pointer-coarse:hidden"
    >
      <Kbd>⌘</Kbd>
      <Kbd>K</Kbd>
    </button>
  )
}
