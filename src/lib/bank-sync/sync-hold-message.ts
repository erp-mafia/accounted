/**
 * What a person reads when a bank sync is held back: a sync was started
 * within the cooldown (BANK_SYNC_COOLDOWN), the bank limits how often the
 * consent is read (BANK_RATE_LIMITED), or the bank is busy for a moment
 * (BANK_THROTTLED). The registry's English sentences
 * (lib/errors/structured-errors.ts) are written for agents and point at the
 * field the time is in (next_allowed_at); a person gets the time itself.
 * Every door that words a hold for a person words it here: the session
 * envelope reader (lib/errors/get-error-message.ts) and the Enable Banking
 * sync route.
 */

export function retryAfterSeconds(until: number, now: number): number {
  return Math.max(1, Math.ceil((until - now) / 1000))
}

export interface HoldText {
  sv: string
  en: string
}

type ClockLocale = 'sv-SE' | 'en-GB'

const MINUTE_MS = 60_000

/**
 * "13:00" the same Stockholm day, otherwise the day first: "21 sep. 08:00".
 * A hold that ends inside a minute is worded as the next whole minute:
 * "at the earliest" never names a minute in which the hold still stands.
 */
function stockholmClock(at: number, now: number, locale: ClockLocale): string {
  const whole = Math.ceil(at / MINUTE_MS) * MINUTE_MS
  const tz = { timeZone: 'Europe/Stockholm' } as const
  const day = (ms: number) => new Intl.DateTimeFormat('sv-SE', { ...tz, dateStyle: 'short' }).format(ms)
  const time = new Intl.DateTimeFormat(locale, { ...tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(whole)
  if (day(whole) === day(now)) return time
  return `${new Intl.DateTimeFormat(locale, { ...tz, day: 'numeric', month: 'short' }).format(whole)} ${time}`
}

/**
 * The time is worded as "at the earliest" in every case: it is our cooldown
 * (the bank's Retry-After when it sent one, bounded backoff otherwise), and
 * it must never read as the bank's confirmed reset time.
 */
export function rateLimitMessages(until: number, now: number): HoldText {
  return {
    sv: `Banken begränsar just nu hur ofta vi får hämta transaktioner. Försök igen tidigast ${stockholmClock(until, now, 'sv-SE')}. Anslutningen behöver inte förnyas.`,
    en: `The bank is temporarily limiting how often we can fetch transactions. Try again at ${stockholmClock(until, now, 'en-GB')} (Swedish time) at the earliest. The connection does not need renewing.`,
  }
}

/**
 * A sync was started within the cooldown. Says no more than that: the code
 * also answers while a sync is running and after one that failed (the lease
 * is taken before the bank is called), so it never claims the rows are fresh.
 */
export function syncCooldownMessages(until: number, now: number): HoldText {
  return {
    sv: `En synkning startades nyligen. Du kan synka igen tidigast ${stockholmClock(until, now, 'sv-SE')}.`,
    en: `A sync was started recently. You can sync again at ${stockholmClock(until, now, 'en-GB')} (Swedish time) at the earliest.`,
  }
}

/**
 * The holds for a reader with no time to show, and the bank's short throttle,
 * which is over in about a minute and is never worded with one. The Swedish
 * halves are the registry's own sentences (kept in step by
 * sync-hold-message.test.ts); the English halves are the person's, since the
 * registry's English is the agent's.
 */
export const SYNC_HOLD_UNTIMED: Readonly<Record<string, HoldText>> = {
  BANK_SYNC_COOLDOWN: {
    sv: 'En synkning startades nyligen. Vänta en kvart mellan synkningarna.',
    en: 'A sync was started recently. Wait a quarter of an hour between syncs.',
  },
  BANK_RATE_LIMITED: {
    sv: 'Banken begränsar just nu hur ofta transaktioner får hämtas. Försök igen senare. Anslutningen behöver inte förnyas.',
    en: 'The bank is temporarily limiting how often we can fetch transactions. Try again later. The connection does not need renewing.',
  },
  BANK_THROTTLED: {
    sv: 'Banken är upptagen just nu. Försök igen om en stund.',
    en: 'The bank is busy right now. Try again in a moment.',
  },
}

const SYNC_HOLD_TIMED: Readonly<Record<string, (until: number, now: number) => HoldText>> = {
  BANK_SYNC_COOLDOWN: syncCooldownMessages,
  BANK_RATE_LIMITED: rateLimitMessages,
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined
}

/**
 * The person's sentence for a held-back sync as its error envelope carries
 * it (code, details.next_allowed_at): with the time when the envelope names
 * one and the hold is worded with one, without it otherwise. Null for every
 * other code.
 */
export function syncHoldMessage(code: unknown, details: unknown, locale: 'sv' | 'en', now: number = Date.now()): string | null {
  if (typeof code !== 'string') return null
  const untimed = own(SYNC_HOLD_UNTIMED, code)
  if (!untimed) return null
  const timed = own(SYNC_HOLD_TIMED, code)
  const at = (details as { next_allowed_at?: unknown } | null | undefined)?.next_allowed_at
  const until = typeof at === 'string' ? Date.parse(at) : Number.NaN
  return (timed && Number.isFinite(until) ? timed(until, now) : untimed)[locale]
}
