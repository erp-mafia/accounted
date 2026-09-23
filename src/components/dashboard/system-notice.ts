/**
 * System notice window: a one-off, operator-set banner ("high load right
 * now") shown to every signed-in user until a fixed point in time.
 *
 * The switch is NEXT_PUBLIC_SYSTEM_NOTICE_UNTIL, an ISO timestamp with an
 * explicit offset (e.g. 2026-09-10T23:00:00+02:00). The value doubles as the
 * dismiss key: closing the banner stores the timestamp in localStorage, so a
 * later notice with a new timestamp shows once again while the old dismissal
 * stays inert. No DB read: the notice must survive the DB being unavailable.
 */

export const SYSTEM_NOTICE_STORAGE_KEY = 'Accounted:system-notice-dismissed'

/**
 * A date-time without Z or a numeric offset is parsed as the runtime's local
 * time, which is UTC on Vercel and whatever the operator's laptop is locally.
 * Require the offset so the deadline means the same instant everywhere.
 */
const HAS_UTC_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i

/**
 * Parse the raw env value into an epoch ms deadline. Returns null when the
 * value is missing, has no UTC offset, is unparseable, or is already in the
 * past, so callers render nothing without a second check.
 */
export function parseSystemNoticeUntil(
  raw: string | undefined | null,
  now: number = Date.now(),
): number | null {
  const trimmed = raw?.trim()
  if (!trimmed) return null
  if (!HAS_UTC_OFFSET.test(trimmed)) return null
  const until = new Date(trimmed).getTime()
  if (!Number.isFinite(until)) return null
  return until > now ? until : null
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export function isSystemNoticeDismissed(
  storage: StorageLike | null | undefined,
  until: number,
): boolean {
  try {
    return storage?.getItem(SYSTEM_NOTICE_STORAGE_KEY) === String(until)
  } catch {
    return false
  }
}

export function dismissSystemNotice(storage: StorageLike | null | undefined, until: number): void {
  try {
    storage?.setItem(SYSTEM_NOTICE_STORAGE_KEY, String(until))
  } catch {
    // Private mode or blocked storage: the banner closes for this page
    // load and may show again next time, which is the acceptable fallback.
  }
}
