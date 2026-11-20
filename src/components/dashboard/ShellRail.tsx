'use client'

import { Fragment, type ReactNode } from 'react'
import { NavLink } from './NavLink'
import { ArrowUpTrayIcon, MagnifyingGlassIcon, PlusIcon, type Icon } from '@/components/icons'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/info-tooltip'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export interface RailEntry {
  id: string
  /** The area's name, written under its icon: what a person reads and what assistive tech announces. */
  label: string
  icon: ReactNode
  /** Where the area lands; null while it cannot be opened (no company yet). */
  href: string | null
  active: boolean
  /** What the button does where its name does not say it (Byrå, inside a company, leads back to the clients): a tooltip. */
  tip?: string | null
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

const RAIL_CONTROL_CLASS =
  'flex flex-shrink-0 items-center justify-center rounded-pop outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/70'
// Create and search: 40px squares that share the first row. A plus and a
// magnifier are read without a word, so they stay icons and name themselves
// in a tooltip; side by side they fill the rail's width (40 + 4 + 40) and the
// rail is no taller than it was with one icon per row.
const RAIL_TOOL_CLASS = cn(RAIL_CONTROL_CLASS, 'h-10 w-10')
// An area: 44px, the 20px icon over the area's name, as wide as the rail
// allows (84px). The rail's own width (--rail-w, globals.css) is what the
// longest name needs with 4px of the button left on each side of it.
const RAIL_AREA_CLASS = cn(RAIL_CONTROL_CLASS, 'h-11 w-full flex-col')
// The smallest label of the type scale, 12px/500. A name wider than the
// button (another language, a white label) ends in an ellipsis instead of
// widening the rail.
const RAIL_LABEL_CLASS = 'max-w-full truncate text-xs font-medium'
const RAIL_IDLE_CLASS = 'text-foreground/80 hover:bg-secondary/60 hover:text-foreground'

/**
 * The rail (V7 shell), the one part of the navigation that sits on the
 * frame: create and search on top, one button per area with the active area
 * on the selected wash, and Agenter and Inställningar pinned at the foot. The
 * areas scroll if the window is too short; the top and the foot never do.
 *
 * Every area shows its name under its icon, always (founder call 2026-11-17:
 * people had to hover each icon to learn what it was). The name is the
 * button's text, so it is also its accessible name, and a tooltip appears
 * only where it says more than the name does.
 */
export function ShellRail({ ariaLabel, creates, createLabel, searchLabel, onSearch, groups, foot, disabledTitle }: ShellRailProps) {
  const tip = (key: string, control: ReactNode, lines: (string | null | undefined)[], side: 'right' | 'bottom' = 'right') => {
    const said = lines.filter((line): line is string => !!line)
    if (said.length === 0) return <Fragment key={key}>{control}</Fragment>
    return (
      <Tooltip key={key}>
        <TooltipTrigger asChild>{control}</TooltipTrigger>
        <TooltipContent side={side} sideOffset={8}>
          {said.map((line, index) => (
            <span key={line} className={cn('block', index === 0 ? 'font-medium text-foreground' : 'text-muted-foreground')}>
              {line}
            </span>
          ))}
        </TooltipContent>
      </Tooltip>
    )
  }

  const button = (entry: RailEntry) => {
    const className = cn(
      RAIL_AREA_CLASS,
      entry.href === null ? 'cursor-not-allowed text-muted-foreground/60' : entry.active ? 'bg-secondary text-strong' : RAIL_IDLE_CLASS,
    )
    const content = (
      <>
        {entry.icon}
        <span className={RAIL_LABEL_CLASS}>{entry.label}</span>
      </>
    )
    const control =
      entry.href === null ? (
        <span role="link" aria-disabled="true" tabIndex={0} className={className}>
          {content}
        </span>
      ) : entry.href.startsWith('https://') ? (
        // A cockpit homed on another host: a plain link, no client-router prefetch across origins.
        <a href={entry.href} className={className}>
          {content}
        </a>
      ) : (
        <NavLink href={entry.href} aria-current={entry.active ? 'page' : undefined} className={className}>
          {content}
        </NavLink>
      )
    return tip(entry.id, control, entry.href === null ? [disabledTitle] : [entry.tip, entry.hint])
  }

  return (
    <nav
      data-shell-rail=""
      data-ph-unmask
      aria-label={ariaLabel}
      className="hidden w-[var(--rail-w)] flex-shrink-0 flex-col gap-1 py-3 md:flex"
    >
      <div className="flex flex-shrink-0 justify-center gap-1">
        {creates.length > 0 && (
          <DropdownMenu>
            {tip(
              'create',
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label={createLabel} className={cn(RAIL_TOOL_CLASS, 'text-strong hover:bg-secondary/60')}>
                  <PlusIcon className="h-5 w-5" />
                </button>
              </DropdownMenuTrigger>,
              [createLabel],
              'bottom',
            )}
            <DropdownMenuContent side="bottom" align="start" sideOffset={6} className="min-w-52">
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
          <button type="button" aria-label={searchLabel} onClick={onSearch} className={cn(RAIL_TOOL_CLASS, RAIL_IDLE_CLASS)}>
            <MagnifyingGlassIcon className="h-5 w-5" />
          </button>,
          [searchLabel, '⌘K'],
          'bottom',
        )}
      </div>
      {/* 6px to the rail's edges, and 2px above and below: room for the focus ring inside the scroller. */}
      <div className="mt-2.5 flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-1.5 py-0.5 [scrollbar-width:none]">
        {groups
          .filter((group) => group.length > 0)
          .map((group, index) => (
            <div key={group[0].id} className={cn('flex flex-shrink-0 flex-col gap-1', index > 0 && 'mt-3')}>
              {group.map(button)}
            </div>
          ))}
      </div>
      {foot.length > 0 && <div className="flex flex-shrink-0 flex-col gap-1 px-1.5">{foot.map(button)}</div>}
    </nav>
  )
}
