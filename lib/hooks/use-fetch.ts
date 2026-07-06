'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale } from 'next-intl'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'

/**
 * Canonical client data-fetching hook.
 *
 * Replaces the hand-rolled `useState(loading)` + `useState(error)` + `useEffect`
 * + bare `fetch()` block repeated across ~85 components. Gives every caller the
 * same behaviour for free:
 *
 *  - cancels the in-flight request on unmount / url change (AbortController), so
 *    a slow response can't land after the component moved on (no stale state,
 *    no "set state on unmounted component" races);
 *  - routes errors through the bilingual `getErrorMessage()` using the active
 *    UI locale, so error copy is consistent and localized;
 *  - exposes `refetch()` for retry / post-mutation refresh.
 *
 * Behaviour notes (intentional):
 *  - `data` is NOT cleared on `refetch()` or url change: it keeps the previous
 *    result while the new request is in flight (keep-previous-data), so lists
 *    don't blank out on refresh. Read `loading` to show a pending indicator.
 *  - When `url`/`enabled` start inactive and later become active, `loading`
 *    flips true on the effect tick, not synchronously on the activating render.
 *    Pair with `DataState` (which branches on `loading` first) to avoid a flash.
 *
 * Response convention: the JSON body is returned as-is, typed as `T`. Most
 * Accounted routes wrap payloads as `{ data: ... }`, so the common usage is
 * `useFetch<{ data: Account[] }>(...)` then read `result.data?.data`. Pass
 * `select` to unwrap/transform at the hook boundary instead.
 *
 * @example
 * const { data, loading, error, refetch } = useFetch<Account[]>(
 *   '/api/bookkeeping/accounts',
 *   { select: (body) => body.data ?? [] },
 * )
 */
export interface UseFetchOptions<T, R> {
  /** Skip the request until true (e.g. waiting on a dependency). Default true. */
  enabled?: boolean
  /** Transform/unwrap the parsed JSON body before it reaches `data`. */
  select?: (body: T) => R
  /** Extra `fetch` init (headers, etc.). The AbortController signal is merged in. */
  init?: Omit<RequestInit, 'signal'>
}

export interface UseFetchResult<R> {
  data: R | null
  loading: boolean
  error: string | null
  /** Re-run the request. Safe to call from event handlers. */
  refetch: () => void
}

export function useFetch<T = unknown, R = T>(
  url: string | null,
  options: UseFetchOptions<T, R> = {},
): UseFetchResult<R> {
  const { enabled = true, select, init } = options
  const locale = useLocale() as ErrorLocale

  // Keep select/init out of the effect deps without re-running on every render.
  const selectRef = useRef(select)
  selectRef.current = select
  const initRef = useRef(init)
  initRef.current = init

  const active = enabled && url != null
  const [data, setData] = useState<R | null>(null)
  const [loading, setLoading] = useState<boolean>(active)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const refetch = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (!active || url == null) {
      setLoading(false)
      return
    }

    const controller = new AbortController()
    setLoading(true)
    setError(null)

    ;(async () => {
      try {
        const res = await fetch(url, { ...initRef.current, signal: controller.signal })
        const body = await res.json().catch(() => null)
        if (!res.ok) {
          throw new Error(
            getErrorMessage(body ?? { error: res.statusText }, { locale, statusCode: res.status }),
          )
        }
        if (controller.signal.aborted) return
        const transform = selectRef.current
        setData((transform ? transform(body as T) : (body as unknown as R)))
      } catch (err) {
        if (controller.signal.aborted || (err as Error)?.name === 'AbortError') return
        setError(getErrorMessage(err, { locale }))
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()

    return () => controller.abort()
  }, [url, active, nonce, locale])

  return { data, loading, error, refetch }
}
