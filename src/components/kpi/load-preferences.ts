import { fetchWithTimeout, isTimeoutError } from '@/lib/http/fetch-with-timeout'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { ActionFailure } from '@/lib/browser/action-failure'
import type { KPIPreferences } from '@/types'
import { KPI_PREFERENCES_URL, readPreferencesBody } from './save-preferences'

/**
 * Read the stored Nyckeltal layout and report exactly what happened.
 *
 * Why this is a module and not five lines in the page: the effect it replaces
 * fell back to `getDefaultPreferences()` on every failed read, silently. That
 * default object then seeded the settings dialog, the dialog sends the
 * complete draft on save, and the PUT route merges the payload over the
 * stored row key by key, so a payload that carries every key replaces the row
 * outright. A read failure thereby became permanent data loss on the user's
 * next save: their stored layout was overwritten by a defaults-based object
 * they never chose. Fixing the write path alone cannot help, because the
 * thing being written is already wrong before the write starts.
 *
 * So this never fabricates a value. Every outcome that is not a complete
 * preferences object read from the server is a failure the page must show,
 * and while the read has failed the page keeps the layout unknown: the grid
 * renders nothing preference-driven and the control that opens the settings
 * dialog stays disabled, because a save seeded from anything but the stored
 * row is exactly the overwrite this module exists to prevent.
 *
 * The failure union is `ActionFailure`, same as the save path, so the page
 * describes a failed read through the same `failureDescription()` vocabulary
 * as a failed save.
 */

/**
 * Deadline for the read.
 *
 * Same value as the save deadline for consistency, though the reasoning is
 * simpler here: a read has no write-ambiguity, the bound only exists so a
 * hung GET surfaces the retry line instead of an eternal skeleton.
 */
export const LOAD_KPI_PREFERENCES_TIMEOUT_MS = 15_000

export type LoadKPIPreferencesResult =
  | { ok: true; preferences: KPIPreferences }
  | ActionFailure

export interface LoadKPIPreferencesOptions {
  /** UI locale, so a server error is reported in the language the user reads. */
  locale?: ErrorLocale
  timeoutMs?: number
}

export async function loadKPIPreferences({
  locale = 'sv',
  timeoutMs = LOAD_KPI_PREFERENCES_TIMEOUT_MS,
}: LoadKPIPreferencesOptions = {}): Promise<LoadKPIPreferencesResult> {
  try {
    const res = await fetchWithTimeout(
      KPI_PREFERENCES_URL,
      { method: 'GET' },
      { timeoutMs, description: `get ${KPI_PREFERENCES_URL}` },
    )

    if (!res.ok) {
      // A body that is not JSON (an HTML error page, an empty 502) leaves
      // `null`, and getErrorMessage falls back to the status map. 401/403 land
      // here too: the page reads the status off this arm to drop the retry,
      // since retrying an expired session cannot succeed.
      const body = await res.json().catch(() => null)
      return {
        ok: false,
        reason: 'server',
        status: res.status,
        message: getErrorMessage(body, { statusCode: res.status, locale }),
      }
    }

    const body = await res.json().catch(() => null)
    const preferences = readPreferencesBody(body)
    if (!preferences) {
      // A 2xx whose body is not a complete preferences object is a FAILED
      // read, never a license to substitute defaults: this is the opposite
      // call from the save path, where a 2xx means the row was already
      // written and the sent payload is the closest truth. Reported on the
      // `network` arm (a corrupt or rewritten body is the truncated-body
      // case that arm documents) because the recourse is the same: retry.
      return { ok: false, reason: 'network', message: getErrorMessage(null, { locale }) }
    }

    return { ok: true, preferences }
  } catch (err) {
    if (isTimeoutError(err)) return { ok: false, reason: 'timeout' }
    return { ok: false, reason: 'network', message: getErrorMessage(err, { locale }) }
  }
}
