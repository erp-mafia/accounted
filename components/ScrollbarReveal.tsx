'use client'

import { useEffect } from 'react'

// How long after the last scroll event the scrollbar stays visible.
const IDLE_MS = 700

/**
 * Reveals scrollbars only while their container is actually scrolling.
 * One capture-phase listener on the document catches scroll events from
 * every scroll container (panel, sidebar, dialogs, dropdown lists) and
 * stamps .is-scrolling on the scrolled element; globals.css makes the
 * thumb visible for that class and transparent otherwise. Renders nothing.
 */
export function ScrollbarReveal() {
  useEffect(() => {
    const timers = new WeakMap<Element, number>()

    const onScroll = (e: Event) => {
      const target = e.target
      const el =
        target === document ? document.documentElement : (target as Element)
      if (!(el instanceof Element)) return
      el.classList.add('is-scrolling')
      const prev = timers.get(el)
      if (prev) window.clearTimeout(prev)
      timers.set(
        el,
        window.setTimeout(() => el.classList.remove('is-scrolling'), IDLE_MS),
      )
    }

    document.addEventListener('scroll', onScroll, {
      capture: true,
      passive: true,
    })
    return () =>
      document.removeEventListener('scroll', onScroll, { capture: true })
  }, [])

  return null
}
