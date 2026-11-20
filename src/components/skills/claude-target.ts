'use client'

import { useCallback, useSyncExternalStore } from 'react'
import { CLAUDE_TARGETS, claudeTargetsFor, usableClaudeTarget, type ClaudeTarget } from './run'

/**
 * The remembered choice of where Claude opens: a convenience per browser,
 * not a setting, so it lives in localStorage and a blocked storage simply
 * means the web default. A launch that opened nothing sets it back to the
 * web (ClaudeStart), so a missing Desktop never becomes the button's face.
 */
const KEY = 'accounted_claude_open_in'
const EVENT = 'accounted-claude-open-in'
const COARSE = '(pointer: coarse)'

function read(): ClaudeTarget {
  try {
    const value = localStorage.getItem(KEY)
    return CLAUDE_TARGETS.includes(value as ClaudeTarget) ? value as ClaudeTarget : 'web'
  } catch {
    return 'web'
  }
}

function subscribeTarget(notify: () => void) {
  window.addEventListener(EVENT, notify)
  return () => window.removeEventListener(EVENT, notify)
}

function subscribeCoarse(notify: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(COARSE)
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}

function readCoarse(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(COARSE).matches
}

/**
 * Where Claude opens on this device, how to change it, and the places this
 * device can open at all: a phone gets the web only, whatever was remembered.
 */
export function useClaudeTarget(): [ClaudeTarget, (target: ClaudeTarget) => void, readonly ClaudeTarget[]] {
  const stored = useSyncExternalStore(subscribeTarget, read, () => 'web' as const)
  const coarse = useSyncExternalStore(subscribeCoarse, readCoarse, () => false)
  const set = useCallback((next: ClaudeTarget) => {
    try { localStorage.setItem(KEY, next) } catch { /* private window: the choice lasts this page only */ }
    window.dispatchEvent(new Event(EVENT))
  }, [])
  return [usableClaudeTarget(stored, coarse), set, claudeTargetsFor(coarse)]
}
