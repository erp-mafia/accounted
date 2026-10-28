import type { SupabaseClient } from '@supabase/supabase-js'
import { ISO_DATE_RE } from '@/lib/invariants'
import { createLogger } from '@/lib/logger'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
import type { ExchangeRate } from '@/types'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { roundOre } from '@/lib/money'

const log = createLogger('riksbanken')

/**
 * Currencies Riksbanken publishes a SEK rate for: SWEA group 130, series
 * SEK<code>PMI, quoted in SEK per ONE unit of the currency. Read from
 * Riksbanken's series list on 2026-10-11: every open series, plus the four
 * closed since 2022 (BGN, MAD, RUB, SAR), which still answer for dates before
 * they closed and have no observation after.
 *
 * A checked list, not SEK<any code>PMI: Riksbanken answers an unknown series
 * with an empty 204, so a mistyped code would cost a request against the
 * per-IP limit and read as "no rate yet", and a series is trusted only once
 * its quoting unit has been read. This is the set a RATE exists for. The set
 * the app can invoice in is CURRENCIES in types/index.ts, a subset
 * (currencies.test.ts pins that).
 */
export const RIKSBANKEN_CURRENCIES: readonly string[] = [
  'AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD',
  'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MAD', 'MXN', 'MYR', 'NOK',
  'NZD', 'PHP', 'PLN', 'RON', 'RUB', 'SAR', 'SGD', 'THB', 'TRY', 'USD', 'ZAR',
]

const RIKSBANKEN_CURRENCY_SET: ReadonlySet<string> = new Set(RIKSBANKEN_CURRENCIES)

function riksbankenSeriesId(currency: string): string | null {
  return RIKSBANKEN_CURRENCY_SET.has(currency) ? `SEK${currency}PMI` : null
}

const OBSERVATIONS_URL = 'https://api.riksbank.se/swea/v1/Observations'

/**
 * Never the Next.js data cache: one URL now answers for a whole year, and a
 * time-revalidated entry is served stale once before it refreshes, which
 * would resolve yesterday from a response fetched before yesterday's rate
 * existed. Reuse lives in the window memo and in exchange_rates instead.
 */
const RIKSBANKEN_REQUEST: RequestInit = { headers: { Accept: 'application/json' }, cache: 'no-store' }

const DAY_MS = 86_400_000
/** A date without an observation (weekend, holiday) takes the latest one at most this many days back. */
const LOOKBACK_DAYS = 7
/** How long a fetched year of observations is reused in this process. */
const WINDOW_TTL_MS = 10 * 60 * 1000
const MAX_MEMO_WINDOWS = 64
/** Longest we wait before the one retry (DECISIONS 2026-09-02: never park a call for the limiter's full ask). */
const RETRY_WAIT_CAP_MS = 5000
const DEFAULT_RETRY_WAIT_MS = 800
const DEFAULT_COOL_OFF_MS = 10_000
const MAX_COOL_OFF_MS = 60_000
const FAILURE_COOL_OFF_MS = 5000

interface Observation {
  date: string
  rate: number
}

interface RateWindow {
  observations: Observation[]
  fetchedAt: number
}

/** Riksbanken refused or failed the request: a temporary state, never "no rate". */
class RiksbankenUnavailableError extends Error {}

// Process-local state. A batch (bulk approval, bank file, sync run) is one
// process, so this is what turns N rows into one request per currency and year.
const windowMemo = new Map<string, RateWindow>()
const windowsInFlight = new Map<string, Promise<RateWindow>>()
let coolOffUntil = 0

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function shiftDay(day: string, days: number): string {
  return isoDay(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS)
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500
}

function retryAfterMs(response: Response): number | null {
  const seconds = Number.parseInt(response.headers.get('retry-after') ?? '', 10)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null
}

function startCoolOff(ms: number): void {
  coolOffUntil = Math.max(coolOffUntil, Date.now() + ms)
}

async function riksbankenFetch(url: string): Promise<Response> {
  try {
    return await fetch(url, RIKSBANKEN_REQUEST)
  } catch (error) {
    startCoolOff(FAILURE_COOL_OFF_MS)
    throw new RiksbankenUnavailableError(error instanceof Error ? error.message : String(error))
  }
}

/**
 * One request, at most one retry. Riksbanken limits calls per IP and says in
 * Retry-After how long to wait: a short wait is honored, a long one is not
 * waited out and not retried (the retry is certain to be refused too).
 * Instead the wait becomes a cool-off for this process, so the rest of a
 * batch fails fast with a retryable answer instead of each row spending five
 * seconds on a request that cannot succeed.
 */
async function requestObservations(url: string): Promise<Response> {
  let response = await riksbankenFetch(url)
  if (!isTransientStatus(response.status)) return response

  const asked = retryAfterMs(response)
  if (asked === null || asked <= RETRY_WAIT_CAP_MS) {
    await new Promise((resolve) => setTimeout(resolve, asked ?? DEFAULT_RETRY_WAIT_MS))
    response = await riksbankenFetch(url)
    if (!isTransientStatus(response.status)) return response
  }

  startCoolOff(
    response.status === 429
      ? Math.min(Math.max(retryAfterMs(response) ?? DEFAULT_COOL_OFF_MS, 1000), MAX_COOL_OFF_MS)
      : FAILURE_COOL_OFF_MS,
  )
  throw new RiksbankenUnavailableError(`Failed to fetch exchange rate: ${response.status}`)
}

/**
 * Every observation of one currency for one calendar year, in ONE request.
 * The range reaches LOOKBACK_DAYS before 1 January (so the first days of the
 * year can look back) and after 31 December (so the last days get a later
 * observation and count as settled, see fetchExchangeRate).
 */
async function fetchWindow(seriesId: string, year: number): Promise<RateWindow> {
  const from = isoDay(Date.UTC(year, 0, 1) - LOOKBACK_DAYS * DAY_MS)
  const to = isoDay(Date.UTC(year, 11, 31) + LOOKBACK_DAYS * DAY_MS)
  const response = await requestObservations(`${OBSERVATIONS_URL}/${seriesId}/${from}/${to}`)

  // 204: nothing published in the range (a year that has not started, or a
  // closed series). An answer, not a failure.
  if (response.status === 204) return { observations: [], fetchedAt: Date.now() }
  if (!response.ok) {
    throw new RiksbankenUnavailableError(`Failed to fetch exchange rate: ${response.status}`)
  }

  const data: unknown = await response.json()
  const observations: Observation[] = []
  if (Array.isArray(data)) {
    for (const item of data as Array<{ date?: unknown; value?: unknown }>) {
      const date = typeof item?.date === 'string' ? item.date.slice(0, 10) : ''
      const rate = parseFloat(String(item?.value))
      if (ISO_DATE_RE.test(date) && Number.isFinite(rate) && rate > 0) {
        observations.push({ date, rate })
      }
    }
  }
  observations.sort((a, b) => a.date.localeCompare(b.date))
  return { observations, fetchedAt: Date.now() }
}

async function loadWindow(currency: string, seriesId: string, year: number): Promise<RateWindow> {
  const key = `${currency}:${year}`
  const memo = windowMemo.get(key)
  if (memo && Date.now() - memo.fetchedAt < WINDOW_TTL_MS) return memo

  // Concurrent lookups (ingest resolves four pairs at a time) share one request.
  const pending = windowsInFlight.get(key)
  if (pending) return pending

  if (Date.now() < coolOffUntil) {
    throw new RiksbankenUnavailableError('Riksbanken asked us to wait before the next request')
  }

  const request = fetchWindow(seriesId, year)
    .then((fetched) => {
      windowMemo.delete(key)
      windowMemo.set(key, fetched)
      if (windowMemo.size > MAX_MEMO_WINDOWS) {
        const oldest = windowMemo.keys().next().value
        if (oldest !== undefined) windowMemo.delete(oldest)
      }
      return fetched
    })
    .finally(() => {
      windowsInFlight.delete(key)
    })
  windowsInFlight.set(key, request)
  return request
}

/** The observation for `day`, or the latest earlier one within the look-back. */
function resolveObservation(observations: Observation[], day: string): Observation | null {
  const earliest = shiftDay(day, -LOOKBACK_DAYS)
  for (let i = observations.length - 1; i >= 0; i--) {
    const observation = observations[i]
    if (observation.date > day) continue
    return observation.date >= earliest ? observation : null
  }
  return null
}

/**
 * True while Riksbanken has just rate-limited or failed a request and the
 * wait it asked for has not passed. A lookup that came back null in that
 * state hit a temporary refusal, not a missing rate: a caller holding a
 * staged operation hands it back for a later approval instead of consuming
 * it (lib/pending-operations/commit.ts).
 */
export function isExchangeRateTemporarilyUnavailable(currency: string): boolean {
  return riksbankenSeriesId(currency) !== null && Date.now() < coolOffUntil
}

let cacheWriter: SupabaseClient | null | undefined
let cacheWriterOverride: SupabaseClient | null | undefined

/**
 * The one client that writes exchange_rates. INSERT is service-role only
 * (migration 20260710100000): the cache is shared by every tenant and feeds
 * money math, so no user session may write it. The caller's client is
 * therefore never used for the write. With a user session (approving staged
 * rows in the app, a bank file import) that write was refused by RLS and
 * silently dropped, which is why the cache only ever filled from the
 * service-role bank sync. Null without the key, and in unit tests.
 */
function rateCacheWriter(): SupabaseClient | null {
  if (cacheWriterOverride !== undefined) return cacheWriterOverride
  if (cacheWriter !== undefined) return cacheWriter
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  cacheWriter = url && key && process.env.NODE_ENV !== 'test' ? createServiceRoleClient(url, key) : null
  return cacheWriter
}

/** Clears the window memo, the cool-off and any injected cache writer. */
export function resetExchangeRateStateForTests(): void {
  windowMemo.clear()
  windowsInFlight.clear()
  coolOffUntil = 0
  cacheWriterOverride = undefined
}

/** Stands in for the service-role client that writes exchange_rates. */
export function setExchangeRateCacheWriterForTests(writer: SupabaseClient | null): void {
  cacheWriterOverride = writer
}

/** Cache reads/writes are best-effort: a cache failure must never block a rate. */
export async function readCachedRate(
  supabase: SupabaseClient,
  currency: string,
  rateDate: string,
): Promise<ExchangeRate | null> {
  try {
    const { data } = await supabase
      .from('exchange_rates')
      .select('rate, observation_date')
      .eq('currency', currency)
      .eq('rate_date', rateDate)
      .maybeSingle()
    if (!data) return null
    return { currency, rate: Number(data.rate), date: data.observation_date as string }
  } catch {
    return null
  }
}

/**
 * Best-effort cache write of one settled (currency, rate_date) answer, by the
 * service-role writer. The value is Riksbanken's own observation: nothing a
 * caller supplies reaches the row except the currency (checked against
 * RIKSBANKEN_CURRENCIES) and the date asked for.
 */
async function writeCachedRate(currency: string, rateDate: string, observation: Observation): Promise<void> {
  const writer = rateCacheWriter()
  if (!writer) return
  try {
    const { error } = await writer.from('exchange_rates').upsert(
      {
        currency,
        rate_date: rateDate,
        rate: observation.rate,
        observation_date: observation.date,
        source: 'riksbanken',
      },
      { onConflict: 'currency,rate_date', ignoreDuplicates: true },
    )
    if (error) log.warn('exchange rate cache not written', { currency, rateDate, reason: error.message })
  } catch {
    // best-effort: a cache write failure must never block the rate
  }
}

/**
 * The most recent cached answer on or before the date, for when Riksbanken
 * cannot be reached. Bounded by the same look-back as a live answer: an
 * observation older than that is not this date's rate, and a retryable
 * refusal is better than booking at a rate from another month.
 */
async function readLatestCachedRate(
  supabase: SupabaseClient,
  currency: string,
  onOrBefore: string,
): Promise<ExchangeRate | null> {
  try {
    const { data } = await supabase
      .from('exchange_rates')
      .select('rate, observation_date')
      .eq('currency', currency)
      .lte('rate_date', onOrBefore)
      .gte('observation_date', shiftDay(onOrBefore, -LOOKBACK_DAYS))
      .order('rate_date', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!data) return null
    return { currency, rate: Number(data.rate), date: data.observation_date as string }
  } catch {
    return null
  }
}

/**
 * The exchange rate for a currency on a given date, from Riksbanken's public
 * API. A date without an observation (weekend, holiday, not published yet)
 * takes the latest earlier one, at most LOOKBACK_DAYS back.
 *
 * One request serves a whole calendar year of one currency and is reused in
 * this process, so a batch of rows over different dates costs one request per
 * currency and year, not one per row. Riksbanken refuses a caller after about
 * five quick requests, which is what a batch on an empty cache used to send.
 *
 * Pass `supabase` to use the shared exchange_rates cache: it is read with that
 * client, and a resolved date is written back by the service-role writer
 * whatever client the caller holds. Only a SETTLED date is written: one
 * Riksbanken has published an observation on or after. Today before
 * publication, or a date ahead, resolves to the latest observation but is not
 * stored, because the row is never updated and would answer with the earlier
 * rate for every company once the real one exists. Without `supabase` nothing
 * is read from or written to the table (a dry run relies on that).
 *
 * Failure semantics: when Riksbanken is unreachable or rate-limited, the most
 * recent CACHED observation within the look-back is returned. With none,
 * returns null: never a hardcoded number, and never 1. Callers treat null as
 * "no rate"; isExchangeRateTemporarilyUnavailable() tells a temporary refusal
 * from a rate that does not exist. A currency outside RIKSBANKEN_CURRENCIES
 * is the permanent kind: null without a request, logged at info, never as an
 * error.
 */
export async function fetchExchangeRate(
  currency: string,
  date?: Date,
  supabase?: SupabaseClient,
): Promise<ExchangeRate | null> {
  if (currency === 'SEK') {
    return {
      currency: 'SEK',
      rate: 1,
      date: todayIsoStockholm(),
    }
  }

  const targetDate = date || new Date()
  const formattedDate = targetDate.toISOString().split('T')[0]

  const seriesId = riksbankenSeriesId(currency)
  if (!seriesId) {
    // An answer, not a failure: real documents carry currencies Riksbanken
    // publishes no series for (Albanian lek receipts read as ALL, prod
    // 2026-10-21), and every caller turns this null into its own honest
    // outcome (no kronor value for a bank match, SI_FX_RATE_MISSING asking
    // for the rate, unsupported_currency in an import). Logged at error, it
    // paged once per inbox item checked.
    log.info('no Riksbanken series for currency: no rate', { currency })
    return null
  }

  if (supabase) {
    const cached = await readCachedRate(supabase, currency, formattedDate)
    if (cached) return cached
  }

  try {
    const year = await loadWindow(currency, seriesId, Number(formattedDate.slice(0, 4)))
    const observation = resolveObservation(year.observations, formattedDate)
    if (!observation) return null

    const latest = year.observations[year.observations.length - 1]
    if (supabase && formattedDate <= latest.date) {
      await writeCachedRate(currency, formattedDate, observation)
    }
    return { currency, rate: observation.rate, date: observation.date }
  } catch (error) {
    // warn, not error: with the cached fallback below this is a degraded-mode
    // path, and the caller's row stays retryable either way.
    log.warn('Error fetching exchange rate:', error)
    if (supabase) {
      const cached = await readLatestCachedRate(supabase, currency, formattedDate)
      if (cached) return cached
    }
    return null
  }
}

/**
 * Convert amount from one currency to SEK, in whole öre. The result is stored
 * as an invoice's *_sek twin and read back by booking builders, so it is
 * rounded here once (roundOre) instead of by each caller.
 */
export function convertToSEK(
  amount: number,
  exchangeRate: number
): number {
  return roundOre(amount * exchangeRate)
}
