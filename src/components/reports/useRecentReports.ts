'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * Tracks the last reports the user opened, per company, in localStorage.
 * Mirrors the `Accounted:<key>:<companyId>` convention used by
 * FiscalYearSelector (STORAGE_KEY_PREFIX). Powers the "Senast öppnad" column
 * in the report catalog table.
 *
 * Storage format: Array<{ s: slug, at: epoch-ms }>. Legacy entries were plain
 * slug strings; those parse without a timestamp and simply show no date.
 */
const STORAGE_KEY_PREFIX = 'Accounted:report-recents:'
const MAX_RECENTS = 12

type StoredRecent = string | { s: string; at: number }

export function useRecentReports(companyId: string | null | undefined) {
  const [openedAt, setOpenedAt] = useState<Record<string, number>>({})

  useEffect(() => {
    let cancelled = false
    // Deferred to a microtask so the read isn't a synchronous setState in the
    // effect body (and so the first server/client render agree on an empty
    // list, avoiding a hydration mismatch).
    Promise.resolve().then(() => {
      if (cancelled) return
      if (!companyId) {
        setOpenedAt({})
        return
      }
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY_PREFIX + companyId)
        const parsed = raw ? (JSON.parse(raw) as StoredRecent[]) : []
        const map: Record<string, number> = {}
        for (const entry of parsed) {
          if (typeof entry === 'object' && entry && entry.s) map[entry.s] = entry.at
        }
        setOpenedAt(map)
      } catch {
        setOpenedAt({})
      }
    })
    return () => {
      cancelled = true
    }
  }, [companyId])

  const pushRecent = useCallback(
    (slug: string) => {
      if (!companyId) return
      setOpenedAt((prev) => {
        const next = { ...prev, [slug]: Date.now() }
        try {
          const stored = Object.entries(next)
            .sort((a, b) => b[1] - a[1])
            .slice(0, MAX_RECENTS)
            .map(([s, at]) => ({ s, at }))
          window.localStorage.setItem(
            STORAGE_KEY_PREFIX + companyId,
            JSON.stringify(stored),
          )
        } catch {
          /* localStorage unavailable: keep in-memory only */
        }
        return next
      })
    },
    [companyId],
  )

  return { openedAt, pushRecent }
}
