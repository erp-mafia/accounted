/**
 * What a person or an agent is told when the bank rate-limits a consent.
 * The cooldown itself lives in sync-lease.ts; this only words it.
 */

export function retryAfterSeconds(until: number, now: number): number {
  return Math.max(1, Math.ceil((until - now) / 1000))
}

/** "13:00" the same Stockholm day, otherwise the day first: "21 sep. 08:00". */
function stockholmClock(at: number, now: number, locale: 'sv-SE' | 'en-GB'): string {
  const tz = { timeZone: 'Europe/Stockholm' } as const
  const day = (ms: number) => new Intl.DateTimeFormat('sv-SE', { ...tz, dateStyle: 'short' }).format(ms)
  const time = new Intl.DateTimeFormat(locale, { ...tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(at)
  if (day(at) === day(now)) return time
  return `${new Intl.DateTimeFormat(locale, { ...tz, day: 'numeric', month: 'short' }).format(at)} ${time}`
}

/**
 * The time is worded as "at the earliest" in every case: it is our cooldown
 * (the bank's Retry-After when it sent one, bounded backoff otherwise), and
 * it must never read as the bank's confirmed reset time.
 */
export function rateLimitMessages(until: number, now: number): { sv: string; en: string } {
  return {
    sv: `Banken begränsar just nu hur ofta vi får hämta transaktioner. Försök igen tidigast ${stockholmClock(until, now, 'sv-SE')}. Anslutningen behöver inte förnyas.`,
    en: `The bank is temporarily limiting how often we can fetch transactions. Try again at ${stockholmClock(until, now, 'en-GB')} (Swedish time) at the earliest. The connection does not need renewing.`,
  }
}
