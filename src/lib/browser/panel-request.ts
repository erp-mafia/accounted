/**
 * The settings panels' server calls (Stripe, Shopify, WooCommerce), each
 * classified into exactly one outcome. Never throws: every arm resolves to a
 * member of the union, so a call site cannot have a silent path by forgetting
 * a `catch`. One toast sentence per click; the classification lives outside
 * the component because component logic has no tests in this repo.
 */

import { fetchWithTimeout, isTimeoutError } from '@/lib/http/fetch-with-timeout'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { ActionFailure } from '@/lib/browser/action-failure'

/** Deadline for the quick calls (status, toggle, disconnect). */
export const PANEL_ACTION_TIMEOUT_MS = 15_000

export type PanelRequestResult<T> =
  /** 2xx. `data` is null when the body was not readable JSON. */
  | { ok: true; data: T | null }
  | ActionFailure

export interface PanelRequestOptions {
  url: string
  /** Defaults to POST: most of the panel calls are mutations. */
  method?: 'GET' | 'POST' | 'DELETE'
  /** JSON request body. Omitted entirely for the routes that ignore it. */
  body?: unknown
  /** UI locale, so a server error is reported in the language the user reads. */
  locale?: ErrorLocale
  timeoutMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * The one sentence for a non-2xx.
 *
 * The extension routes refuse with a hand-written Swedish sentence in
 * `{ error }`, and that sentence is the most specific thing anyone can say:
 * "Inget anslutet Stripe-konto." tells the user to reconnect, where the status
 * map's "Resursen kunde inte hittas." tells them nothing. `getErrorMessage`
 * keeps such a sentence only when it happens to carry one of its Swedish
 * trigger words, which this route copy does not, so the string is preferred
 * explicitly.
 *
 * `error_en` is honoured first for an English UI because the shared capability
 * guard emits both (`capabilityBlockedResponse` in
 * lib/entitlements/has-capability.ts), and `getErrorMessage` only reads
 * `message_en` inside a structured envelope, not a top-level `error_en`.
 *
 * Everything else is `getErrorMessage`'s: a structured envelope, an HTML 502
 * from the platform, a body that never parsed.
 */
export function serverErrorMessage(
  body: unknown,
  status: number,
  locale: ErrorLocale,
): string {
  if (isRecord(body)) {
    if (locale === 'en' && typeof body.error_en === 'string' && body.error_en.trim()) {
      return body.error_en.trim()
    }
    if (typeof body.error === 'string' && body.error.trim()) {
      return body.error.trim()
    }
  }
  return getErrorMessage(body, { statusCode: status, locale })
}

/** Call one of a panel's endpoints and report exactly why it failed. */
export async function panelRequest<T>({
  url,
  method = 'POST',
  body,
  locale = 'sv',
  timeoutMs = PANEL_ACTION_TIMEOUT_MS,
}: PanelRequestOptions): Promise<PanelRequestResult<T>> {
  try {
    const res = await fetchWithTimeout(
      url,
      body === undefined
        ? { method }
        : {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
      { timeoutMs, description: `${method} ${url}` },
    )

    // Read the body on both arms: the failure arm needs the route's own
    // sentence, the success arm needs the sync counts. A body that is not JSON
    // (an HTML error page, an empty 502, a response truncated mid-stream) leaves
    // null, and neither arm then claims anything it cannot support.
    const payload = await res.json().catch(() => null)

    if (!res.ok) {
      return {
        ok: false,
        reason: 'server',
        status: res.status,
        message: serverErrorMessage(payload, res.status, locale),
      }
    }

    return { ok: true, data: payload as T | null }
  } catch (err) {
    if (isTimeoutError(err)) return { ok: false, reason: 'timeout' }
    return { ok: false, reason: 'network', message: getErrorMessage(err, { locale }) }
  }
}
