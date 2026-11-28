'use client'

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { useLocale } from 'next-intl'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'

/** The `data` of GET /api/user/preferences, as a row reads it. */
export type StoredPreferences = Record<string, unknown> | undefined

/**
 * One value a settings row of Ditt konto reads from GET /api/user/preferences
 * (FabVisibilityRow, StartPageRow). `pick` turns the answer's `data` into the
 * row's value; pass a stable function (module scope or useCallback), since a
 * new one reads again.
 *
 * A settings row that cannot read its own value must not render one:
 * defaulting on a failed GET drew a loaded-looking, interactive control
 * whatever the stored preference was. So the unknown value stays unknown
 * (null) and `loadError` says why. 401/403 is the only case where the reason
 * changes what the user must do, so its message (from the same status map the
 * save paths use) comes as `detail` and the row shows it instead of a retry;
 * everything else is transient (detail null) and `retry` is the whole answer.
 *
 * `setValue` is for the row's own optimistic save and its roll back.
 */
export function useStoredPreference<T>(pick: (data: StoredPreferences) => T): {
  value: T | null
  setValue: Dispatch<SetStateAction<T | null>>
  loadError: { detail: string | null } | null
  retry: () => void
} {
  const errorLocale = useLocale() as ErrorLocale
  // null = the value is not known: still loading, or the read failed (loadError).
  const [value, setValue] = useState<T | null>(null)
  const [loadError, setLoadError] = useState<{ detail: string | null } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoadError(null)
      try {
        const res = await fetch('/api/user/preferences')
        if (!res.ok) {
          // Not-JSON bodies (an HTML error page, an empty 502) leave null, and
          // getErrorMessage falls back to the status map.
          const body = await res.json().catch(() => null)
          if (cancelled) return
          const sessionGone = res.status === 401 || res.status === 403
          setValue(null)
          setLoadError({
            detail: sessionGone
              ? getErrorMessage(body, { statusCode: res.status, locale: errorLocale })
              : null,
          })
          return
        }
        // A 200 whose body will not parse is a failed read too: let it land in
        // the catch below rather than become a fabricated value.
        const body = await res.json()
        if (!cancelled) setValue(() => pick(body?.data))
      } catch {
        if (!cancelled) {
          setValue(null)
          setLoadError({ detail: null })
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [reloadKey, errorLocale, pick])

  return { value, setValue, loadError, retry: () => setReloadKey((k) => k + 1) }
}
