'use client'

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import type { CommandPaletteGateProps } from './CommandPalette'
import { COMMAND_PALETTE_OPEN_EVENT, isCommandPaletteShortcut } from './command-palette-events'

const CommandPalette = dynamic(() => import('./CommandPalette'), { ssr: false })

/**
 * Defers the command palette bundle (Radix dialog + its icon set) until the
 * first ⌘K / Ctrl+K press or the first tap on a CommandPaletteTrigger. The
 * palette is mounted on every dashboard page but used on demand, so eagerly
 * parsing it on initial load was pure cost. Once mounted, the palette's own
 * listeners take over toggling; this wrapper's listeners fire only once.
 *
 * The props are the layout's nav flags: the palette gates its destinations
 * with the same values DashboardNav gets (nav-gates.ts).
 */
export default function LazyCommandPalette(props: CommandPaletteGateProps) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    if (mounted) return
    function onKey(e: KeyboardEvent) {
      if (isCommandPaletteShortcut(e)) {
        e.preventDefault()
        setMounted(true)
      }
    }
    function onOpen() {
      setMounted(true)
    }
    document.addEventListener('keydown', onKey)
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpen)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpen)
    }
  }, [mounted])

  return mounted ? <CommandPalette initialOpen {...props} /> : null
}
