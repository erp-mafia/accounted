'use client'

import { Search } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { openCommandPalette } from './command-palette-events'
import { commandPaletteShortcutLabel, useIsApplePlatform } from './use-shortcut-modifier'

interface CommandPaletteTriggerProps {
  /**
   * sidebar: a nav-row button with the chord on the right (desktop, both shells).
   * rail: icon only, for the collapsed v1 rail.
   * mobile: a sheet row at touch height, no chord (there is no keyboard).
   */
  variant: 'sidebar' | 'rail' | 'mobile'
  /** Runs before the palette opens (the mobile sheet closes itself). */
  onOpen?: () => void
  className?: string
}

/**
 * The visible way into the command palette. Until this existed the palette
 * was keyboard-only and nothing in the UI said ⌘K was there, so most users
 * never found it and touch users could not reach it at all. The chord is
 * shown as ⌘K on Apple platforms and Ctrl K elsewhere.
 */
export function CommandPaletteTrigger({ variant, onOpen, className }: CommandPaletteTriggerProps) {
  const t = useTranslations('command_palette')
  const shortcut = commandPaletteShortcutLabel(useIsApplePlatform())
  const title = t('trigger_aria', { shortcut })
  const open = () => {
    onOpen?.()
    openCommandPalette()
  }

  if (variant === 'rail') {
    return (
      <button
        type="button"
        onClick={open}
        aria-label={title}
        aria-keyshortcuts="Meta+K Control+K"
        title={title}
        className={cn(
          'flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-secondary/60 hover:text-foreground',
          className,
        )}
      >
        <Search className="h-[15px] w-[15px]" />
      </button>
    )
  }

  if (variant === 'mobile') {
    return (
      <button
        type="button"
        onClick={open}
        aria-keyshortcuts="Meta+K Control+K"
        className={cn(
          'flex min-h-[44px] w-full items-center gap-3 rounded-lg px-3 text-foreground transition-colors active:bg-muted/60',
          className,
        )}
      >
        <Search className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
        <span className="flex-1 text-left text-sm">{t('trigger_label')}</span>
      </button>
    )
  }

  // Same geometry as a sidebar nav row (SidebarV2 / DashboardNav), so it
  // reads as part of the menu rather than a widget dropped on top of it.
  return (
    <button
      type="button"
      onClick={open}
      aria-keyshortcuts="Meta+K Control+K"
      title={title}
      className={cn(
        'group flex w-full items-center rounded-lg px-3 py-[7px] text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-secondary/60 hover:text-foreground',
        className,
      )}
    >
      <Search className="mr-2.5 h-[15px] w-[15px] flex-shrink-0 text-muted-foreground group-hover:text-foreground" />
      <span className="flex-1 truncate text-left">{t('trigger_label')}</span>
      <kbd
        aria-hidden="true"
        className="ml-auto rounded-sm border border-border px-1 font-sans text-[10px] leading-4 text-muted-foreground/80"
      >
        {shortcut}
      </kbd>
    </button>
  )
}
