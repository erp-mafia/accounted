import { fetchWithTimeout, isTimeoutError } from '@/lib/http/fetch-with-timeout'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { ActionFailure } from '@/lib/browser/action-failure'
import type { KPIPreferences } from '@/types'

/**
 * Save the Nyckeltal layout and report exactly what happened.
 *
 * Why this is a module and not four lines in the page: the handler it replaces
 * had an empty catch commented "Silently fail: user can retry", and that catch
 * covered both the `!res.ok` throw and every thrown fetch, so a rejected save
 * was indistinguishable from a successful one. The settings dialog closed, the grid
 * kept rendering the draft the user had just picked, and the next page load read
 * the untouched row back from `extension_data` and reverted the layout. "The
 * user can retry" only holds if the user knows there is something to retry.
 *
 * `postAction` cannot serve this call: it is a bodyless POST that deliberately
 * ignores the success body, whereas this is a PUT carrying the preferences and
 * the echoed row is what the page renders afterwards. The failure union is
 * `ActionFailure` all the same, so the page describes a failed save through the
 * same `failureDescription()` as a failed download elsewhere in the app.
 *
 * The request is bounded for the reason every interactive mutation is: an
 * unbounded PUT leaves the dialog's Save button spinning forever if an instance
 * hangs, and the only recourse the user has is to click again.
 */

/**
 * Deadline for the save.
 *
 * Same value as POST_ACTION_TIMEOUT_MS, and deliberately not shorter: aborting
 * early reports a failure for a write that may well have landed, and on this
 * surface that ambiguity would push the user into a second save.
 */
export const SAVE_KPI_PREFERENCES_TIMEOUT_MS = 15_000

export const KPI_PREFERENCES_URL = '/api/kpi/preferences'

export type SaveKPIPreferencesResult =
  | { ok: true; preferences: KPIPreferences }
  | ActionFailure

export interface SaveKPIPreferencesOptions {
  /** Sent whole: the route treats every key as optional, and a sparse PUT would leave the page rendering keys it never confirmed. */
  preferences: KPIPreferences
  /** UI locale, so a server error is reported in the language the user reads. */
  locale?: ErrorLocale
  timeoutMs?: number
}

/**
 * Read a preferences object out of a `{ data: <row> }` response body.
 *
 * Both routes answer this shape: the PUT echoes the merge of the caller's
 * payload over what was already stored, and the GET returns the stored row
 * merged with defaults. Anything that is not a complete preferences object
 * (an empty 200, a proxy that rewrote the body) yields `null`: assigning
 * `undefined` into the page's preferences state used to be a live crash path,
 * since both the grid and the dialog read `.visibleKpis` off it without a
 * guard. Shared with `loadKPIPreferences()`, where a `null` means the read
 * failed rather than "render the payload instead".
 */
export function readPreferencesBody(body: unknown): KPIPreferences | null {
  if (!body || typeof body !== 'object') return null
  const data = (body as { data?: unknown }).data
  if (!data || typeof data !== 'object') return null

  const candidate = data as Partial<KPIPreferences>
  const overrides = candidate.accountOverrides
  if (
    !Array.isArray(candidate.visibleKpis) ||
    !Array.isArray(candidate.kpiOrder) ||
    !overrides ||
    typeof overrides !== 'object' ||
    Array.isArray(overrides) ||
    // Both routes merge defaults before answering, so the flag is always a
    // boolean from this server; anything else is not a preferences object.
    typeof candidate.showMonthlyTable !== 'boolean'
  ) {
    return null
  }

  return {
    visibleKpis: candidate.visibleKpis,
    kpiOrder: candidate.kpiOrder,
    accountOverrides: overrides,
    showMonthlyTable: candidate.showMonthlyTable,
  }
}

export async function saveKPIPreferences({
  preferences,
  locale = 'sv',
  timeoutMs = SAVE_KPI_PREFERENCES_TIMEOUT_MS,
}: SaveKPIPreferencesOptions): Promise<SaveKPIPreferencesResult> {
  try {
    const res = await fetchWithTimeout(
      KPI_PREFERENCES_URL,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(preferences),
      },
      { timeoutMs, description: `put ${KPI_PREFERENCES_URL}` },
    )

    if (!res.ok) {
      // A body that is not JSON (an HTML error page, an empty 502) leaves
      // `null`, and getErrorMessage falls back to the status map.
      const body = await res.json().catch(() => null)
      return {
        ok: false,
        reason: 'server',
        status: res.status,
        message: getErrorMessage(body, { statusCode: res.status, locale }),
      }
    }

    const body = await res.json().catch(() => null)
    // A 2xx means the row was written, so this is not a failure even when the
    // echo is unusable: reporting "not saved" for a save that landed is the
    // same lie as the old silent catch, pointing the other way. The payload the
    // caller sent is then the closest truthful thing to render.
    return { ok: true, preferences: readPreferencesBody(body) ?? preferences }
  } catch (err) {
    if (isTimeoutError(err)) return { ok: false, reason: 'timeout' }
    return { ok: false, reason: 'network', message: getErrorMessage(err, { locale }) }
  }
}
