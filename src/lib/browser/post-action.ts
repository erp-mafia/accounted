/**
 * Fire a state-changing POST from a click and report exactly why it failed.
 *
 * Why this lives next to `downloadFile`: the same try/finally-with-no-catch
 * shape that silently swallowed download failures also sits on the mutation
 * buttons beside them, and `downloadFile` cannot serve those (it exists to save
 * a blob). The result union is deliberately the same one, so a panel maps a
 * failed download and a failed mutation through a single `failureDescription`.
 *
 * The request is bounded for the same reason a download is: an unbounded POST
 * on a click leaves the button spinning forever when a serverless instance
 * hangs, and the user's only recourse is to click again, which is the one thing
 * you least want on a mutation.
 *
 * The success body is deliberately not parsed. `res.ok` is the whole contract:
 * validating a success shape would couple every button to its route's payload,
 * and the server has already committed the write by the time it flushes
 * headers, so a body that never finishes arriving would not change the outcome.
 */

import { fetchWithTimeout, isTimeoutError } from '@/lib/http/fetch-with-timeout'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { ActionFailure } from './action-failure'

/**
 * Deadline for an interactive mutation.
 *
 * Same realistic worst case as an artefact download: a serverless cold start
 * plus one eu-north-1 round trip, a few seconds. It is deliberately no shorter
 * than DOWNLOAD_TIMEOUT_MS, because aborting a mutation early reports a failure
 * for a write that may well have landed, and that ambiguity is worse than a few
 * extra seconds of spinner.
 */
export const POST_ACTION_TIMEOUT_MS = 15_000

export type PostActionResult = { ok: true } | ActionFailure

export interface PostActionOptions {
  url: string
  /** UI locale, so a server error is reported in the language the user reads. */
  locale?: ErrorLocale
  timeoutMs?: number
}

export async function postAction({
  url,
  locale = 'sv',
  timeoutMs = POST_ACTION_TIMEOUT_MS,
}: PostActionOptions): Promise<PostActionResult> {
  try {
    const res = await fetchWithTimeout(
      url,
      { method: 'POST' },
      { timeoutMs, description: `post ${url}` },
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

    return { ok: true }
  } catch (err) {
    if (isTimeoutError(err)) return { ok: false, reason: 'timeout' }
    return { ok: false, reason: 'network', message: getErrorMessage(err, { locale }) }
  }
}
