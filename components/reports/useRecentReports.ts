'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * Tracks the last few report slugs the user opened, per company, in
 * localStorage. Mirrors the `Accounted:<key>:<companyId>` convention used by
 * FiscalYearSelector (STORAGE_KEY_PREFIX). Powers the "Senast öppnade" shelf
 * so returning users skip the library hop.
 */
const STORAGE_KEY_PREFIX = 'Accounted:report-recents:'
const MAX_RECENTS = 4

export function useRecentReports(companyId: string | null | undefined) {
  const [recents, setRecents] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    // Deferred to a microtask so the read isn't a synchronous setState in the
    // effect body (and so the first server/client render agree on an empty
    // shelf, avoiding a hydration mismatch).
    Promise.resolve().then(() => {
      if (cancelled) return
      if (!companyId) {
        setRecents([])
        return
      }
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY_PREFIX + companyId)
        setRecents(raw ? (JSON.parse(raw) as string[]) : [])
      } catch {
        setRecents([])
      }
    })
    return () => {
      cancelled = true
    }
  }, [companyId])

  const pushRecent = useCallback(
    (slug: string) => {
      if (!companyId) return
      setRecents((prev) => {
        const next = [slug, ...prev.filter((s) => s !== slug)].slice(0, MAX_RECENTS)
        try {
          window.localStorage.setItem(STORAGE_KEY_PREFIX + companyId, JSON.stringify(next))
        } catch {
          /* localStorage unavailable: keep in-memory only */
        }
        return next
      })
    },
    [companyId],
  )

  return { recents, pushRecent }
}
