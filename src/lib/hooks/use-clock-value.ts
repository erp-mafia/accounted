'use client'

import { useSyncExternalStore } from 'react'
import { APP_TIME_ZONE } from '@/i18n/config'

/** The clock is read on render; nothing re-renders when it ticks. */
const subscribe = () => () => {}

/**
 * A value read off the clock in a client component: the hour behind a
 * time-of-day greeting, today's weekday. A client component renders on the
 * server first and again in the browser while it hydrates, and React needs
 * both renders to produce the same text. Read off each machine's own clock
 * they differ whenever the server's zone (UTC on Vercel) and the user's fall
 * on either side of a boundary: a greeting that turns at 10 differed from
 * 10:00 to 11:59 Stockholm summer time, React threw error #418 and replaced
 * the server HTML with a client render. Here the server render and hydration
 * both read the clock in the app's zone (APP_TIME_ZONE, Stockholm), so they
 * agree; right after hydration the value is read again in the browser's own
 * zone, which changes it only for a user outside Sweden's.
 *
 * `read` gets the instant and the zone to read it in (undefined: the
 * runtime's own). It returns a string or a number, so an unchanged read
 * compares equal and React does not render again.
 */
export function useClockValue<T extends string | number>(read: (now: Date, timeZone?: string) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => read(new Date()),
    () => read(new Date(), APP_TIME_ZONE),
  )
}

/** The hour of `now` (0 to 23) in `timeZone`, or in the runtime's own zone. */
export function hourIn(now: Date, timeZone?: string): number {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone }).format(now))
}
