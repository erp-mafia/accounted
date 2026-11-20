'use client'

import { useEffect } from 'react'
import { holdSoftNavigation } from '@/lib/browser/deploy-navigation'

/**
 * While `active`, a tab that is behind a deploy does not turn a link click
 * into a full page load (lib/browser/deploy-navigation.ts): navigation stays
 * exactly as it is without a pending deploy. For work a full load would
 * destroy but a soft navigation keeps, such as a draft in the docked assistant.
 */
export function useHoldSoftNavigation(active: boolean) {
  useEffect(() => {
    if (!active) return
    return holdSoftNavigation()
  }, [active])
}

/**
 * Attaches a `beforeunload` event listener when the form has unsaved changes.
 * This guards against browser close, tab close, and page refresh.
 *
 * Does NOT guard in-app Next.js navigation (App Router has no supported mechanism).
 * A pending deploy does not change that: the hold keeps link clicks soft, so
 * the browser's "leave site?" dialog never appears where it did not before.
 */
export function useUnsavedChanges(isDirty: boolean) {
  useHoldSoftNavigation(isDirty)
  useEffect(() => {
    if (!isDirty) return

    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }

    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])
}
