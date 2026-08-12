'use client'

import { useEffect } from 'react'

/**
 * Mirrors the app's real background into <meta name="theme-color"> so the
 * browser chrome (iOS status bar, Android address bar) always matches what
 * is on screen. A static viewport color cannot: dark mode is a class toggle
 * (next-themes) and color palettes swap --background at runtime via
 * data-palette, both on <html>.
 */
export function ThemeColorSync() {
  useEffect(() => {
    const root = document.documentElement
    const sync = () => {
      const bg = getComputedStyle(root).getPropertyValue('--background').trim()
      if (!bg) return
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', `hsl(${bg})`)
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'data-palette'] })
    return () => observer.disconnect()
  }, [])
  return null
}
