import { createLogger } from '@/lib/logger'

/**
 * The POSTING_EVENTS switch of the posting port (step 1 of Phase 2).
 *
 *   off     (the default, also for an unset or unknown value) the port hands
 *           the producer's input to the engine exactly as before and writes
 *           nothing else: booking output and every query are what they were.
 *   shadow  the port records the business event and the engine links it to
 *           the draft before a voucher number is drawn. A failed event or
 *           link write is logged and the posting goes ahead without it.
 *   strict  as shadow, but a failed event or link write stops the posting
 *           before a voucher number is drawn (the draft is left cancelled,
 *           as any other failure before the commit leaves it). Wired and
 *           tested, NOT to be enabled until step 2 has moved every producer
 *           onto the port and shadow coverage has held: until then only the
 *           pilot writes events, and strict would stop bookings over a
 *           record nothing reads yet.
 *
 * Read on every call, never cached: an instance picks up a changed value at
 * its next posting, and tests switch it with vi.stubEnv.
 */
export type PostingEventsMode = 'off' | 'shadow' | 'strict'

export const POSTING_EVENTS_MODES: readonly PostingEventsMode[] = ['off', 'shadow', 'strict']

const log = createLogger('posting.mode')
let warnedUnknown: string | null = null

export function postingEventsMode(env: Record<string, string | undefined> = process.env): PostingEventsMode {
  const raw = env.POSTING_EVENTS?.trim().toLowerCase()
  if (!raw) return 'off'
  if ((POSTING_EVENTS_MODES as readonly string[]).includes(raw)) return raw as PostingEventsMode
  if (warnedUnknown !== raw) {
    warnedUnknown = raw
    log.warn('POSTING_EVENTS has an unknown value; the posting port stays off', { value: raw })
  }
  return 'off'
}
