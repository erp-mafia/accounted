'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  backMove,
  previousStepIndex,
  readHistoryMarker,
  readNavigationDraft,
  recordNavigation,
  replaceNavigation,
  resumeDraft,
  type NavigationDraft,
} from '@/lib/onboarding/navigation'

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

/**
 * One browser entry per question; refresh restores the current tab's draft.
 * Back goes through the browser only across entries this flow pushed itself
 * (lib/onboarding/navigation backMove); anything else is restored in place.
 */
export function useOnboardingNavigation<S>(options: Options<S>) {
  const key = `accounted:onboarding:v1:${options.scope}`
  const latest = useRef(options)
  useEffect(() => { latest.current = options })
  const draft = useRef<NavigationDraft<S> | null>(null)
  // How many entries directly behind the current one this flow pushed itself.
  const depth = useRef(0)
  const restoring = useRef(false)
  const replacing = useRef(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let saved: NavigationDraft<S> | null = null
    try { saved = readNavigationDraft<S>(sessionStorage.getItem(key), Date.now()) } catch { /* Storage can be disabled. */ }
    if (latest.current.resetOnMount) saved = null
    if (saved && latest.current.reconcileDraft) saved = latest.current.reconcileDraft(saved)
    const resumed = resumeDraft(saved, readHistoryMarker(window.history.state, key))
    draft.current = resumed.draft
    depth.current = resumed.depth
    if (resumed.draft) {
      restoring.current = true
      latest.current.restore(resumed.draft.entries[resumed.draft.index].state)
    }
    // Browser storage is only available after hydration; restore before showing a question.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReady(true)

    function onPop(event: PopStateEvent) {
      const marker = readHistoryMarker(event.state, key)
      const current = draft.current
      if (!current || !marker || !current.entries[marker.index]) return
      if (latest.current.blocked || latest.current.complete) {
        const distance = current.index - marker.index
        if (distance) window.history.go(distance)
        return
      }
      draft.current = { ...current, index: marker.index }
      depth.current = marker.depth
      restoring.current = true
      latest.current.restore(current.entries[marker.index].state)
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
    const wasReplacing = replacing.current
    restoring.current = false
    replacing.current = false
    const next = wasReplacing
      ? replaceNavigation(previous, options.step, options.state, Date.now())
      : recordNavigation(previous, options.step, options.state, Date.now(), options.beforeStep)
    const pushed = !wasRestoring && !!previous && next.index !== previous.index
    if (pushed) depth.current += 1
    draft.current = next
    const marker = { ...window.history.state, onboarding: { key, index: next.index, depth: depth.current } }
    if (pushed) window.history.pushState(marker, '')
    else window.history.replaceState(marker, '')
    try { sessionStorage.setItem(key, JSON.stringify(next)) } catch { /* In-memory history still works. */ }
  }, [key, ready, options.step, options.state, options.beforeStep, options.complete])

  const goTo = useCallback((target: number, fallback: () => void) => {
    const current = draft.current
    const move = backMove(current?.index ?? 0, depth.current, current ? target : -1)
    if (move.kind === 'fallback' || !current) return fallback()
    if (move.kind === 'history') return window.history.go(-move.distance)
    draft.current = { ...current, index: move.index }
    // The entries behind this one no longer line up with the draft.
    depth.current = 0
    restoring.current = true
    latest.current.restore(current.entries[move.index].state)
  }, [])

  const back = useCallback((fallback: () => void) => {
    if (latest.current.blocked) return
    goTo(draft.current ? previousStepIndex(draft.current) : -1, fallback)
  }, [goTo])

  const backTo = useCallback((matches: (state: S) => boolean, fallback: () => void) => {
    if (latest.current.blocked) return
    const current = draft.current
    goTo(current?.entries.findIndex((entry, index) => index < current.index && matches(entry.state)) ?? -1, fallback)
  }, [goTo])

  /**
   * A step back the flow takes itself, as a fallback when the draft holds
   * nothing earlier: it replaces the current entry, so the next Back moves on
   * instead of undoing it.
   */
  const stepBack = useCallback((move: () => void) => {
    replacing.current = true
    move()
    // A click's update and its effects run before any timer: a move that
    // changed nothing must not turn the next forward step into a replacement.
    setTimeout(() => { replacing.current = false })
  }, [])

  const clear = useCallback(() => {
    draft.current = null
    try { sessionStorage.removeItem(key) } catch { /* Storage can be disabled. */ }
  }, [key])

  return { ready, back, backTo, stepBack, clear }
}
