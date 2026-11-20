'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Global ⌘, / Ctrl+, shortcut to open settings (mirrors CommandPalette's ⌘K).
 * Navigates to /settings, the full settings page.
 */
export function SettingsHotkey() {
  const router = useRouter()

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        router.push('/settings')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [router])

  return null
}
