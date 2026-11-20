/**
 * What a fetch outcome does to a domain's row, and when it is tried again.
 * Pure.
 *
 *   found     the icon is stored; refreshed after a year (brands redraw).
 *   missing   the site answered and has no usable icon: again in 30 days.
 *   blocked   403, robots.txt or an unsafe address: again in 90 days.
 *   excluded  never again.
 *   retry     a timeout, a 5xx, an unreachable robots.txt: again the next
 *             day, at most three attempts; the third failure moves the row
 *             to the 30-day window and the count starts over.
 * A refresh that fails never throws a found icon away: the row keeps its
 * file and is only tried again later.
 */
import type { FetchOutcome, IconSource } from './fetch'

export type VendorLogoStatus = 'pending' | 'found' | 'missing' | 'blocked' | 'excluded'

export const MISSING_RETRY_DAYS = 30
export const BLOCKED_RETRY_DAYS = 90
export const FOUND_REFRESH_DAYS = 365
export const RETRY_AFTER_DAYS = 1
export const MAX_ATTEMPTS = 3

export interface VendorLogoRow {
  domain: string
  status: VendorLogoStatus
  attempts: number
}

export interface VendorLogoUpdate {
  status?: VendorLogoStatus
  storage_path?: string
  source?: IconSource
  width?: number | null
  sha256?: string
  attempts: number
  fetched_at: string
  next_attempt_at: string | null
}

const DAY_MS = 86_400_000

/** The public bucket the icons live in (20260420120000_logos_bucket.sql). */
export const LOGO_BUCKET = 'logos'

/** Where a found icon lives in the logos bucket: its content hash, never its domain. */
export function storagePathFor(sha256: string): string {
  return `vendor-icons/${sha256}.png`
}

export function nextState(row: VendorLogoRow, outcome: FetchOutcome, now: Date): VendorLogoUpdate {
  const at = (days: number) => new Date(now.getTime() + days * DAY_MS).toISOString()
  const fetched_at = now.toISOString()
  const keepsIcon = row.status === 'found'
  switch (outcome.status) {
    case 'found':
      return {
        status: 'found',
        storage_path: storagePathFor(outcome.icon.sha256),
        source: outcome.source,
        width: outcome.icon.width,
        sha256: outcome.icon.sha256,
        attempts: 0,
        fetched_at,
        next_attempt_at: at(FOUND_REFRESH_DAYS),
      }
    case 'excluded':
      return { status: 'excluded', attempts: 0, fetched_at, next_attempt_at: null }
    case 'missing':
      return { ...(keepsIcon ? {} : { status: 'missing' as const }), attempts: 0, fetched_at, next_attempt_at: at(MISSING_RETRY_DAYS) }
    case 'blocked':
      return { ...(keepsIcon ? {} : { status: 'blocked' as const }), attempts: 0, fetched_at, next_attempt_at: at(BLOCKED_RETRY_DAYS) }
    case 'retry': {
      const attempts = row.attempts + 1
      if (attempts >= MAX_ATTEMPTS) {
        return { ...(keepsIcon ? {} : { status: 'missing' as const }), attempts: 0, fetched_at, next_attempt_at: at(MISSING_RETRY_DAYS) }
      }
      return { attempts, fetched_at, next_attempt_at: at(RETRY_AFTER_DAYS) }
    }
  }
}
