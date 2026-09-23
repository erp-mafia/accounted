/**
 * Fetch a server-generated file and save it to disk only if the server
 * actually produced one.
 *
 * Why: the download boilerplate that repeats across the app reads
 * `await res.blob()` straight after `fetch`, with no `res.ok` check. A failing
 * route answers with a JSON error envelope, and `blob()` happily wraps that
 * envelope. The anchor click then writes it to disk under the real file's
 * name, so the user ends up holding `bokforingsmallar.json` (or an .sie, or a
 * .zip) that contains `{"error":{"code":"INTERNAL_ERROR",...}}` while the UI
 * reports nothing at all. That file looks like an export, gets filed as a
 * backup, gets mailed to an accountant, and only fails much later when someone
 * tries to import it.
 *
 * Content-Type cannot be used to tell the two apart: a JSON export and a JSON
 * error envelope are both `application/json`, and a 500 from a route that
 * streams a ZIP is still JSON. `res.ok` is the only honest discriminator, so
 * the status is checked before the body is ever turned into a blob.
 *
 * The request is also bounded. An unbounded artefact fetch on a click leaves
 * the button spinning forever when a serverless instance hangs, and the user's
 * only recourse is to click again.
 *
 * The result is a discriminated union rather than a thrown error so the call
 * site can pick exactly one truthful message. That matters here: TOAST_LIMIT
 * is 1 (components/ui/use-toast.tsx), so two toasts emitted in the same tick
 * leave the user seeing only the last one.
 */

import { fetchWithTimeout, isTimeoutError } from '@/lib/http/fetch-with-timeout'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'

/**
 * Default deadline for an interactive artefact download.
 *
 * These payloads are small (a JSON export, a declaration file) and produced by
 * a single indexed query, so the realistic worst case is a serverless cold
 * start plus one eu-north-1 round trip: a few seconds. 15s leaves several times
 * that headroom, so we never abort a request that was about to succeed, while
 * still ending the spinner soon enough after the ~10s mark where the user has
 * already concluded the app is dead. Callers that generate genuinely heavy
 * artefacts (full-archive ZIPs) should pass a larger `timeoutMs`.
 */
export const DOWNLOAD_TIMEOUT_MS = 15_000

export type DownloadFileResult =
  /** 2xx and a complete body: the file was handed to the browser. */
  | { ok: true; filename: string }
  /** The deadline passed. Nothing was saved; report it as a timeout, not as a generic failure. */
  | { ok: false; reason: 'timeout' }
  /** The server answered non-2xx. `message` is the envelope's own message when it carries one. */
  | { ok: false; reason: 'server'; status: number; message: string }
  /** The request never completed (offline, DNS, connection reset, truncated body). */
  | { ok: false; reason: 'network'; message: string }

export interface DownloadFileOptions {
  url: string
  /** Name the file is saved under. */
  filename: string
  /** UI locale, so a server error is reported in the language the user reads. */
  locale?: ErrorLocale
  timeoutMs?: number
  /** Seam for tests; defaults to the DOM anchor implementation below. */
  saveBlob?: (blob: Blob, filename: string) => void
}

/**
 * How long the object URL outlives the click before it is revoked.
 *
 * Revoking synchronously right after `a.click()` can abort the save in
 * Firefox and Safari: the click only STARTS the download, and the browser may
 * still be reading from the blob URL when it is revoked. 10 seconds is far
 * beyond any realistic gap between the click and the browser opening its own
 * handle on the blob, while still guaranteeing the URL (and the blob memory
 * it pins) is released.
 */
export const OBJECT_URL_REVOKE_DELAY_MS = 10_000

/**
 * Hand a blob to the browser as a download.
 *
 * The anchor is attached to the document before it is clicked: a detached
 * anchor is ignored by some browsers, which turns the download into a silent
 * no-op.
 */
export function saveBlobToDisk(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  let clicked = false
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    clicked = true
    a.remove()
  } finally {
    if (clicked) {
      // The download started: defer revocation so the browser can finish
      // reading the blob (see OBJECT_URL_REVOKE_DELAY_MS).
      setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_REVOKE_DELAY_MS)
    } else {
      // The click never happened (DOM threw): nothing is reading the URL,
      // so release it immediately rather than leaking it for 10 seconds.
      URL.revokeObjectURL(url)
    }
  }
}

export async function downloadFile({
  url,
  filename,
  locale = 'sv',
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
  saveBlob = saveBlobToDisk,
}: DownloadFileOptions): Promise<DownloadFileResult> {
  let blob: Blob

  try {
    const res = await fetchWithTimeout(
      url,
      { method: 'GET' },
      { timeoutMs, description: `download ${filename}` },
    )

    if (!res.ok) {
      // Read the body only now that we know it is not the file. A body that is
      // not JSON (an HTML error page, an empty 502) leaves `null`, and
      // getErrorMessage falls back to the status map.
      const body = await res.json().catch(() => null)
      return {
        ok: false,
        reason: 'server',
        status: res.status,
        message: getErrorMessage(body, { statusCode: res.status, locale }),
      }
    }

    blob = await res.blob()
  } catch (err) {
    if (isTimeoutError(err)) return { ok: false, reason: 'timeout' }
    return { ok: false, reason: 'network', message: getErrorMessage(err, { locale }) }
  }

  // Only reached with a 2xx and a body that was read in full.
  saveBlob(blob, filename)
  return { ok: true, filename }
}
