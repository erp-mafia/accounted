/**
 * Client-side load of one report payload, and the rule that keeps a report
 * view on the request its current parameters asked for.
 *
 * Every report view used to carry its own fetch effect, and most of them set
 * state from whichever response came back last. Switching räkenskapsår (or the
 * date range, the dimension, the per-datum date) while the previous request
 * was still in flight could then paint the older parameters' figures under
 * the newer picker. The views now share one hook (lib/hooks/use-report-data.ts)
 * and the logic it relies on lives here, where it is testable without a DOM:
 *
 *  - startReportRequest aborts through its cleanup and never settles once
 *    cancelled, so a superseded response is dropped;
 *  - viewReportData only reads a settled result tagged with the CURRENT
 *    request key, so a response can never surface under other parameters.
 *
 * Nothing is cached between requests: a report opens on fresh figures, as it
 * did before, and only the latest payload is held in memory.
 */

import { getErrorMessage } from '@/lib/errors/get-error-message'

/** A finished request, tagged with the key it was requested under. */
export interface SettledReport<T> {
  key: string
  data: T | null
  error: string | null
}

/** What a report view renders from: data, error, or still loading. */
export interface ReportDataView<T> {
  data: T | null
  error: string | null
  loading: boolean
}

/**
 * One key per request: the URL plus a counter that refetch() bumps, so asking
 * again for the same URL is a new request whose answer the old one cannot
 * stand in for.
 */
export function reportRequestKey(url: string, attempt: number): string {
  return `${attempt}:${url}`
}

/**
 * Fetches one report route and unwraps its `{ data }` envelope. An error
 * envelope becomes its user-facing message (getErrorMessage); a network or
 * parse failure becomes `fallbackError`, the view's own line. Never rejects.
 */
export async function fetchReportData<T>(
  url: string,
  fallbackError: string,
  signal?: AbortSignal,
): Promise<{ data: T | null; error: string | null }> {
  try {
    const res = await fetch(url, { signal })
    const body = await res.json()
    // `body.error` is the canonical envelope OBJECT: rendering it bare threw
    // "Objects are not valid as a React child" and blanked the report page.
    if (body?.error) return { data: null, error: getErrorMessage(body) }
    return { data: (body?.data ?? null) as T | null, error: null }
  } catch {
    return { data: null, error: fallbackError }
  }
}

/**
 * Starts the request for `key` and hands its outcome to `settle`, unless the
 * returned cancel function ran first (the hook's effect cleanup, on the next
 * parameter change or unmount): then the fetch is aborted and nothing settles.
 */
export function startReportRequest<T>(
  key: string,
  url: string,
  fallbackError: string,
  settle: (result: SettledReport<T>) => void,
): () => void {
  const controller = new AbortController()
  void fetchReportData<T>(url, fallbackError, controller.signal).then((outcome) => {
    if (!controller.signal.aborted) settle({ key, ...outcome })
  })
  return () => controller.abort()
}

/**
 * The view of the current request. A null key means nothing is requested
 * (a prerequisite such as the period is missing). A settled result for any
 * other key is ignored: the view keeps loading until its own answer lands.
 */
export function viewReportData<T>(
  settled: SettledReport<T> | null,
  key: string | null,
): ReportDataView<T> {
  if (key === null) return { data: null, error: null, loading: false }
  if (settled === null || settled.key !== key) return { data: null, error: null, loading: true }
  return { data: settled.data, error: settled.error, loading: false }
}
