'use client'

import type { ReactNode } from 'react'
import { NavLink } from './NavLink'
import { ArrowUpTrayIcon, MagnifyingGlassIcon, PlusIcon, type Icon } from '@/components/icons'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/info-tooltip'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export interface RailEntry {
  id: string
  label: string
  icon: ReactNode
  /** Where the area lands; null while it cannot be opened (no company yet). */
  href: string | null
  active: boolean
  /** A second tooltip line (the host a cross-host cockpit link leads to). */
  hint?: string | null
}

/** One line of the rail's create menu: an area's create action. */
export interface RailCreate {
  key: string
  label: string
  symbol?: 'upload'
  /**
   * The icon of the area the action belongs to, as on the rail: seven rows
   * with the same plus are hard to tell apart, and the opener already says
   * "create". An upload keeps the upload arrow.
   */
  icon?: Icon
  href?: string
  onSelect?: () => void
}

interface ShellRailProps {
  ariaLabel: string
  /** The create actions of every area the company has, behind the plus; empty hides the plus. */
  creates: RailCreate[]
  createLabel: string
  searchLabel: string
  /** Opens the command palette. */
  onSearch: () => void
  /** The areas in rail order, a small gap between groups. */
  groups: RailEntry[][]
  /** Pinned at the bottom, in view without scrolling: Agenter, Inställningar, Byrå. */
  foot: RailEntry[]
  disabledTitle: string
}

// The prototype's rail button (kit/board.py RB): 40px, 10px radius, a 20px icon.
const RAIL_BUTTON_CLASS =
  'flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-pop outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/70'
const RAIL_IDLE_CLASS = 'text-foreground/70 hover:bg-secondary/60 hover:text-foreground'

/**
 * The icon rail (V7 shell), the one part of the navigation that sits on the
 * frame: create and search on top, one button per area with the active area
 * on the selected wash, and Agenter and Inställningar pinned at the foot. The
 * areas scroll if the window is too short; the top and the foot never do.
 * Each button names itself to assistive tech (aria-label) and on hover or
 * focus (a tooltip, which takes no focus of its own).
 */
export function ShellRail({ ariaLabel, creates, createLabel, searchLabel, onSearch, groups, foot, disabledTitle }: ShellRailProps) {
  const tip = (key: string, control: ReactNode, label: string, hint?: string | null) => (
    <Tooltip key={key}>
      <TooltipTrigger asChild>{control}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        <span className="block font-medium text-foreground">{label}</span>
        {hint && <span className="block text-muted-foreground">{hint}</span>}
      </TooltipContent>
    </Tooltip>
  )

  const button = (entry: RailEntry) => {
    const className = cn(
      RAIL_BUTTON_CLASS,
      entry.href === null ? 'cursor-not-allowed text-muted-foreground/60' : entry.active ? 'bg-secondary text-strong' : RAIL_IDLE_CLASS,
    )
    const control =
      entry.href === null ? (
        <span role="link" aria-disabled="true" aria-label={entry.label} tabIndex={0} className={className}>
          {entry.icon}
        </span>
      ) : entry.href.startsWith('https://') ? (
        // A cockpit homed on another host: a plain link, no client-router prefetch across origins.
        <a href={entry.href} aria-label={entry.label} className={className}>
          {entry.icon}
        </a>
      ) : (
        <NavLink href={entry.href} aria-label={entry.label} aria-current={entry.active ? 'page' : undefined} className={className}>
          {entry.icon}
        </NavLink>
      )
    return tip(entry.id, control, entry.label, entry.href === null ? disabledTitle : entry.hint)
  }

  return (
    <nav
      data-shell-rail=""
      data-ph-unmask
      aria-label={ariaLabel}
      className="hidden w-[var(--rail-w)] flex-shrink-0 flex-col items-center gap-1 py-3 md:flex"
    >
      {creates.length > 0 && (
        <DropdownMenu>
          {tip(
            'create',
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label={createLabel} className={cn(RAIL_BUTTON_CLASS, 'text-strong hover:bg-secondary/60')}>
                <PlusIcon className="h-5 w-5" />
              </button>
            </DropdownMenuTrigger>,
            createLabel,
          )}
          <DropdownMenuContent side="right" align="start" sideOffset={8} className="min-w-52">
            {creates.map((create) => {
              const Symbol = create.symbol === 'upload' ? ArrowUpTrayIcon : (create.icon ?? PlusIcon)
              const content = (
                <>
                  <Symbol className="h-4 w-4 text-foreground/70" />
                  {create.label}
                </>
              )
              return create.href ? (
                <DropdownMenuItem key={create.key} asChild>
                  <NavLink href={create.href}>{content}</NavLink>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem key={create.key} onSelect={create.onSelect}>
                  {content}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {tip(
        'search',
        <button type="button" aria-label={searchLabel} onClick={onSearch} className={cn(RAIL_BUTTON_CLASS, RAIL_IDLE_CLASS)}>
          <MagnifyingGlassIcon className="h-5 w-5" />
        </button>,
        searchLabel,
        '⌘K',
      )}
      <div className="mt-3 flex min-h-0 flex-1 flex-col items-center overflow-y-auto overflow-x-hidden px-2.5 [scrollbar-width:none]">
        {groups
          .filter((group) => group.length > 0)
          .map((group, index) => (
            <div key={group[0].id} className={cn('flex flex-col items-center gap-1', index > 0 && 'mt-4')}>
              {group.map(button)}
            </div>
          ))}
      </div>
      {foot.length > 0 && <div className="flex flex-shrink-0 flex-col items-center gap-1">{foot.map(button)}</div>}
    </nav>
  )
}
