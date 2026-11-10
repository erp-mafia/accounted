'use client'

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'

interface Position { panel: number; window: number }
const positions = new Map<string, Position>()

/** Restore back/forward positions after async content has regained its height. */
export function useHistoryScroll(companyId: string | null, pathname: string) {
  const contentRef = useRef<HTMLDivElement>(null)
  const current = useRef('')
  const pending = useRef<string | null>(null)
  const restoring = useRef(false)
  const cancel = useRef<() => void>(() => {})
  const key = useCallback(() => `Accounted:scroll:${companyId ?? 'none'}:${location.pathname}${location.search}`, [companyId])

  useEffect(() => {
    const previous = history.scrollRestoration
    history.scrollRestoration = 'manual'
    const save = () => {
      if (restoring.current || !current.current) return
      const position = { panel: document.getElementById('main-content')?.scrollTop ?? 0, window: window.scrollY }
      positions.set(current.current, position)
      try { sessionStorage.setItem(current.current, JSON.stringify(position)) } catch { /* Memory is enough for this tab. */ }
    }
    const pop = () => { pending.current = key() }
    document.addEventListener('scroll', save, { capture: true, passive: true })
    window.addEventListener('scroll', save, { passive: true })
    window.addEventListener('popstate', pop)
    return () => {
      cancel.current()
      history.scrollRestoration = previous
      document.removeEventListener('scroll', save, true)
      window.removeEventListener('scroll', save)
      window.removeEventListener('popstate', pop)
    }
  }, [companyId, key])

  useLayoutEffect(() => {
    cancel.current()
    const targetKey = key()
    current.current = targetKey
    const panel = document.getElementById('main-content')
    if (pending.current !== targetKey) {
      panel?.scrollTo(0, 0)
      window.scrollTo(0, 0)
      return
    }
    pending.current = null
    let position = positions.get(targetKey)
    if (!position) {
      try {
        const saved = JSON.parse(sessionStorage.getItem(targetKey) ?? 'null')
        if (saved && Number.isFinite(saved.panel) && Number.isFinite(saved.window)) position = saved
      } catch { /* A missing position starts at the top. */ }
    }
    const target = position ?? { panel: 0, window: 0 }
    restoring.current = true
    let frame = 0
    const stop = () => {
      restoring.current = false
      cancelAnimationFrame(frame)
      observer.disconnect()
      clearTimeout(timeout)
      window.removeEventListener('wheel', stop)
      window.removeEventListener('touchstart', stop)
      window.removeEventListener('keydown', stop)
    }
    const restore = () => {
      panel?.scrollTo(0, target.panel)
      window.scrollTo(0, target.window)
      if (Math.abs((panel?.scrollTop ?? 0) - target.panel) < 2 && Math.abs(window.scrollY - target.window) < 2) stop()
    }
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(restore) })
    if (contentRef.current) observer.observe(contentRef.current)
    const timeout = setTimeout(stop, 5000)
    window.addEventListener('wheel', stop, { passive: true })
    window.addEventListener('touchstart', stop, { passive: true })
    window.addEventListener('keydown', stop)
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(restore) })
    cancel.current = stop
    return stop
  }, [companyId, pathname, key])

  return contentRef
}
