'use client'

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'

const CommandPalette = dynamic(() => import('./CommandPalette'), { ssr: false })

/**
 * Defers the command palette bundle (Radix dialog + its icon set) until the
 * first ⌘K / Ctrl+K press. The palette is mounted on every dashboard page but
 * used only by keyboard, so eagerly parsing it on initial load was pure cost.
 * Once mounted, the palette's own global key listener takes over toggling;
 * this wrapper's listener only fires the first time.
 */
export default function LazyCommandPalette() {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    if (mounted) return
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setMounted(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [mounted])

  return mounted ? <CommandPalette initialOpen /> : null
}
