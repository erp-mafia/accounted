'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { readNavigationDraft, recordNavigation, type NavigationDraft } from '@/lib/onboarding/navigation'

interface Options<S> {
  scope: string
  step: string
  state: S
  restore: (state: S) => void
  beforeStep?: (previous: S, current: S) => S
  reconcileDraft?: (draft: NavigationDraft<S>) => NavigationDraft<S> | null
  blocked: boolean
  resetOnMount?: boolean
  complete?: boolean
}

/** One browser entry per question; refresh restores the current tab's draft. */
export function useOnboardingNavigation<S>(options: Options<S>) {
  const key = `accounted:onboarding:v1:${options.scope}`
  const latest = useRef(options)
  useEffect(() => { latest.current = options })
  const draft = useRef<NavigationDraft<S> | null>(null)
  const restoring = useRef(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let saved: NavigationDraft<S> | null = null
    try { saved = readNavigationDraft<S>(sessionStorage.getItem(key), Date.now()) } catch { /* Storage can be disabled. */ }
    if (latest.current.resetOnMount) saved = null
    if (saved && latest.current.reconcileDraft) saved = latest.current.reconcileDraft(saved)
    draft.current = saved
    if (saved) {
      restoring.current = true
      latest.current.restore(saved.entries[saved.index].state)
    }
    // Browser storage is only available after hydration; restore before showing a question.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReady(true)

    function onPop(event: PopStateEvent) {
      const marker = event.state?.onboarding as { key?: string; index?: number } | undefined
      const current = draft.current
      if (!current || marker?.key !== key || !Number.isInteger(marker.index)) return
      const index = marker.index as number
      if (!current.entries[index]) return
      if (latest.current.blocked || latest.current.complete) {
        const distance = current.index - index
        if (distance) window.history.go(distance)
        return
      }
      draft.current = { ...current, index }
      restoring.current = true
      latest.current.restore(current.entries[index].state)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [key])

  useEffect(() => {
    if (!ready) return
    if (options.complete) {
      try { sessionStorage.removeItem(key) } catch { /* Storage can be disabled. */ }
      return
    }
    const previous = draft.current
    const wasRestoring = restoring.current
    restoring.current = false
    const next = recordNavigation(previous, options.step, options.state, Date.now(), options.beforeStep)
    draft.current = next
    const marker = { ...window.history.state, onboarding: { key, index: next.index } }
    if (!wasRestoring && previous && next.index !== previous.index) window.history.pushState(marker, '')
    else window.history.replaceState(marker, '')
    try { sessionStorage.setItem(key, JSON.stringify(next)) } catch { /* In-memory history still works. */ }
  }, [key, ready, options.step, options.state, options.beforeStep, options.complete])

  const back = useCallback((fallback: () => void) => {
    if (latest.current.blocked) return
    if (draft.current && draft.current.index > 0) window.history.back()
    else fallback()
  }, [])

  const backTo = useCallback((matches: (state: S) => boolean, fallback: () => void) => {
    if (latest.current.blocked) return
    const current = draft.current
    const index = current?.entries.findIndex((entry, index) => index < current.index && matches(entry.state)) ?? -1
    if (current && index >= 0) window.history.go(index - current.index)
    else fallback()
  }, [])

  const clear = useCallback(() => {
    draft.current = null
    try { sessionStorage.removeItem(key) } catch { /* Storage can be disabled. */ }
  }, [key])

  return { ready, back, backTo, clear }
}
