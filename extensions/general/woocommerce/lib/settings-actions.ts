/**
 * The WooCommerce settings panel's server calls, each classified into exactly
 * one outcome. Same doctrine as the Stripe panel's settings-actions (see the
 * doc block there): never throw, one toast sentence per click, and the
 * classification lives outside the component because component logic has no
 * tests in this repo.
 */

import { fetchWithTimeout, isTimeoutError } from '@/lib/http/fetch-with-timeout'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import type { ActionFailure } from '@/lib/browser/action-failure'

/**
 * Deadline for the quick calls (status, toggle, disconnect). Connect and
 * manual-connect probe the merchant's WooCommerce host (often a slow shared
 * PHP box, with retries), so they get a longer one.
 */
export const WOO_ACTION_TIMEOUT_MS = 15_000
export const WOO_CONNECT_TIMEOUT_MS = 120_000

/**
 * Deadline for "Synka nu": the route's own ceiling (maxDuration 300 on the
 * extension dispatcher) plus margin, same reasoning as the Stripe panel. A
 * first sync backfills 90 days from a slow host and legitimately takes
 * minutes; the server keeps working and advances the cursor even if we
 * aborted, so aborting early would misreport a sync that landed.
 */
export const WOO_SYNC_TIMEOUT_MS = 310_000

export type WooRequestResult<T> =
  /** 2xx. `data` is null when the body was not readable JSON. */
  | { ok: true; data: T | null }
  | ActionFailure

export interface WooRequestOptions {
  url: string
  method?: 'GET' | 'POST' | 'DELETE'
  body?: unknown
  locale?: ErrorLocale
  timeoutMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The one sentence for a non-2xx; route copy wins over the generic map. */
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

/** Call one of the panel's endpoints and report exactly why it failed. */
export async function wooRequest<T>({
  url,
  method = 'POST',
  body,
  locale = 'sv',
  timeoutMs = WOO_ACTION_TIMEOUT_MS,
}: WooRequestOptions): Promise<WooRequestResult<T>> {
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

/** Success body of POST /api/extensions/ext/woocommerce/sync. */
export interface WooSyncPayload {
  success?: boolean
  /** `WooCommerceSyncSummary` from lib/order-sync.ts, over the wire. */
  transactions?: {
    fetched?: number
    refundsFetched?: number
    inserted?: number
    updated?: number
    unchanged?: number
    errors?: number
    revoked?: boolean
    deadlineReached?: boolean
  } | null
}

type SyncCounts = {
  fetched: number
  imported: number
}

export type WooSyncSummary =
  /** The store rejected the credentials; the connection was flipped to revoked. */
  | { reason: 'revoked' }
  /** The window genuinely held nothing. A real answer, not a silent success. */
  | { reason: 'empty' }
  /**
   * The time budget ran out with orders still unfetched. Reported before the
   * count-based outcomes so a truncated run never reads as a complete one;
   * the cursor persisted, so pressing sync again continues where it stopped.
   * Carries the error count too: a truncated run can also have failed rows,
   * and dropping that number would repeat the silent-partial mistake.
   */
  | { reason: 'partial'; values: SyncCounts & { errors: number } }
  /** Rows landed, and some rows did not. Both halves get said. */
  | { reason: 'errors'; values: SyncCounts & { errors: number } }
  /** Rows landed. */
  | { reason: 'feed'; values: SyncCounts }
  /** 2xx whose body could not be read: the sync ran, the counts are unknown. */
  | { reason: 'unknown' }

/** Turn the sync route's success body into the single sentence the user gets. */
export function syncSummary(payload: WooSyncPayload | null): WooSyncSummary {
  const summary = payload?.transactions
  if (!summary) return { reason: 'unknown' }
  if (summary.revoked === true) return { reason: 'revoked' }
  if (typeof summary.fetched !== 'number') return { reason: 'unknown' }

  const fetched = summary.fetched
  // "imported" in the user-facing sentence = new rows this run (inserts).
  const imported = typeof summary.inserted === 'number' ? summary.inserted : 0
  const errors = typeof summary.errors === 'number' ? summary.errors : 0

  if (summary.deadlineReached === true) {
    return { reason: 'partial', values: { fetched, imported, errors } }
  }
  if (fetched === 0) return { reason: 'empty' }
  if (errors > 0) return { reason: 'errors', values: { fetched, imported, errors } }
  return { reason: 'feed', values: { fetched, imported } }
}
