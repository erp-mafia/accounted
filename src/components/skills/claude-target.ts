'use client'

import { useCallback, useSyncExternalStore } from 'react'
import { CLAUDE_TARGETS, type ClaudeTarget } from './run'

/**
 * The remembered choice of where Claude opens: a convenience per browser,
 * not a setting, so it lives in localStorage and a blocked storage simply
 * means the web default.
 */
const KEY = 'accounted_claude_open_in'
const EVENT = 'accounted-claude-open-in'

function read(): ClaudeTarget {
  try {
    const value = localStorage.getItem(KEY)
    return CLAUDE_TARGETS.includes(value as ClaudeTarget) ? value as ClaudeTarget : 'web'
  } catch {
    return 'web'
  }
}

export function useClaudeTarget(): [ClaudeTarget, (target: ClaudeTarget) => void] {
  const target = useSyncExternalStore(
    (notify) => { window.addEventListener(EVENT, notify); return () => window.removeEventListener(EVENT, notify) },
    read,
    () => 'web' as const,
  )
  const set = useCallback((next: ClaudeTarget) => {
    try { localStorage.setItem(KEY, next) } catch { /* private window: the choice lasts this page only */ }
    window.dispatchEvent(new Event(EVENT))
  }, [])
  return [target, set]
}
