'use client'

import { useEffect } from 'react'

/**
 * Attaches a `beforeunload` event listener when the form has unsaved changes.
 * This guards against browser close, tab close, and page refresh.
 *
 * Does NOT guard in-app Next.js navigation (App Router has no supported mechanism).
 */
export function useUnsavedChanges(isDirty: boolean) {
  useEffect(() => {
    if (!isDirty) return

    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }

    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])
}
