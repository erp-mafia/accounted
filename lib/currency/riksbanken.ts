import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import type { Currency, ExchangeRate } from '@/types'

const log = createLogger('riksbanken')

/** Riksbanken series IDs for each currency */
const SERIES_IDS: Record<Currency, string> = {
  SEK: '',
  EUR: 'SEKEURPMI',
  USD: 'SEKUSDPMI',
  GBP: 'SEKGBPPMI',
  NOK: 'SEKNOKPMI',
  DKK: 'SEKDKKPMI',
}

const RIKSBANKEN_HEADERS = { Accept: 'application/json' }

/**
 * One retry on 429/5xx, honoring Retry-After (capped at 5s). Riksbanken
 * rate-limits the public API; without this the morning sync cron's fan-out
 * turned a single 429 into a failed rate for the whole batch.
 */
async function fetchWithRetry(url: string): Promise<Response> {
  const first = await fetch(url, { headers: RIKSBANKEN_HEADERS, next: { revalidate: 3600 } })
  if (first.status !== 429 && first.status < 500) return first
  const retryAfterSeconds = Number.parseInt(first.headers.get('retry-after') ?? '', 10)
  const delayMs = Number.isFinite(retryAfterSeconds)
    ? Math.min(retryAfterSeconds * 1000, 5000)
    : 800
  await new Promise((resolve) => setTimeout(resolve, delayMs))
  return fetch(url, { headers: RIKSBANKEN_HEADERS, next: { revalidate: 3600 } })
}

/** Cache reads/writes are best-effort — a cache failure must never block a rate. */
async function readCachedRate(
  supabase: SupabaseClient,
  currency: Currency,
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

async function writeCachedRate(
  supabase: SupabaseClient,
  currency: Currency,
  rateDate: string,
  rate: ExchangeRate,
): Promise<void> {
  try {
    await supabase.from('exchange_rates').upsert(
      {
        currency,
        rate_date: rateDate,
        rate: rate.rate,
        observation_date: rate.date,
        source: 'riksbanken',
      },
      { onConflict: 'currency,rate_date', ignoreDuplicates: true },
    )
  } catch {
    // best-effort
  }
}

async function readLatestCachedRate(
  supabase: SupabaseClient,
  currency: Currency,
  onOrBefore: string,
): Promise<ExchangeRate | null> {
  try {
    const { data } = await supabase
      .from('exchange_rates')
      .select('rate, observation_date')
      .eq('currency', currency)
      .lte('rate_date', onOrBefore)
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
 * Fetch the exchange rate for a currency on a given date from Riksbanken's
 * public API, with an optional persistent read-through cache.
 *
 * Pass `supabase` from server contexts (the sync cron's ingest path does) to
 * read/write the shared exchange_rates cache — repeat dates then cost one DB
 * lookup instead of an API call, across all companies.
 *
 * Failure semantics: when Riksbanken is unreachable/rate-limited even after
 * one retry, the most recent CACHED observation on or before the date is
 * returned. With no cache hit either, returns null — never a hardcoded
 * number. (Hardcoded fallback rates used to get silently booked into
 * amount_sek whenever the 05:00 cron got 429'd.) Callers treat null as "no
 * rate": the transaction is inserted without amount_sek/exchange_rate and
 * can be repaired via /api/transactions/[id]/refresh-exchange-rate.
 */
export async function fetchExchangeRate(
  currency: Currency,
  date?: Date,
  supabase?: SupabaseClient,
): Promise<ExchangeRate | null> {
  if (currency === 'SEK') {
    return {
      currency: 'SEK',
      rate: 1,
      date: new Date().toISOString().split('T')[0],
    }
  }

  const targetDate = date || new Date()
  const formattedDate = targetDate.toISOString().split('T')[0]

  const seriesId = SERIES_IDS[currency]
  if (!seriesId) {
    log.error(`Unknown currency: ${currency}`)
    return null
  }

  if (supabase) {
    const cached = await readCachedRate(supabase, currency, formattedDate)
    if (cached) return cached
  }

  try {
    // Riksbanken's public API endpoint
    const url = `https://api.riksbank.se/swea/v1/Observations/${seriesId}/${formattedDate}/${formattedDate}`
    const response = await fetchWithRetry(url)

    let result: ExchangeRate | null = null

    if (response.status === 429 || response.status >= 500) {
      // Rate-limited/unavailable even after the retry. Do NOT fire the
      // 7-day range request — it would hit the same limiter and double the
      // load, which is how the old code turned one 429 into two.
      throw new Error(`Failed to fetch exchange rate: ${response.status}`)
    }

    if (response.ok && response.status !== 204) {
      const data = await response.json()
      if (data && data.length > 0) {
        result = { currency, rate: parseFloat(data[0].value), date: data[0].date }
      }
    }

    // 204 / empty / 404: no observation for this exact date (weekend,
    // holiday, rate not published yet) — look back 7 days for the latest.
    if (!result) {
      const to = formattedDate
      const fromDate = new Date(targetDate)
      fromDate.setDate(fromDate.getDate() - 7)
      const from = fromDate.toISOString().split('T')[0]

      const fallbackUrl = `https://api.riksbank.se/swea/v1/Observations/${seriesId}/${from}/${to}`
      const fallbackResponse = await fetchWithRetry(fallbackUrl)

      if (!fallbackResponse.ok || fallbackResponse.status === 204) {
        throw new Error(`Failed to fetch exchange rate: ${fallbackResponse.status}`)
      }

      const fallbackData = await fallbackResponse.json()
      if (fallbackData && fallbackData.length > 0) {
        const latest = fallbackData[fallbackData.length - 1]
        result = { currency, rate: parseFloat(latest.value), date: latest.date }
      }
    }

    if (result && supabase) {
      await writeCachedRate(supabase, currency, formattedDate, result)
    }
    return result
  } catch (error) {
    // warn, not error: with the cached fallback below this is a degraded-mode
    // path, and the transaction stays repairable either way.
    log.warn('Error fetching exchange rate:', error)
    if (supabase) {
      const cached = await readLatestCachedRate(supabase, currency, formattedDate)
      if (cached) return cached
    }
    return null
  }
}

/**
 * Fallback exchange rates for when the API is unavailable. Display-only:
 * fetchMultipleRates uses these to keep its fully-populated-Map contract.
 * The booking path (fetchExchangeRate) never returns them — a made-up rate
 * silently booked into amount_sek is worse than no rate.
 */
function getFallbackRate(currency: Currency): ExchangeRate {
  const fallbackRates: Record<Currency, number> = {
    SEK: 1,
    EUR: 11.5, // ~11.5 SEK per EUR
    USD: 10.5, // ~10.5 SEK per USD
    GBP: 13.5, // ~13.5 SEK per GBP
    NOK: 1.0, // ~1 SEK per NOK
    DKK: 1.55, // ~1.55 SEK per DKK
  }

  return {
    currency,
    rate: fallbackRates[currency],
    date: new Date().toISOString().split('T')[0],
  }
}

/**
 * Convert amount from one currency to SEK
 */
export function convertToSEK(
  amount: number,
  exchangeRate: number
): number {
  return amount * exchangeRate
}

/**
 * Format currency amount with proper symbol
 */
export function formatCurrencyAmount(
  amount: number,
  currency: Currency
): string {
  const symbols: Record<Currency, string> = {
    SEK: 'kr',
    EUR: '€',
    USD: '$',
    GBP: '£',
    NOK: 'kr',
    DKK: 'kr',
  }

  const formatted = new Intl.NumberFormat('sv-SE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)

  if (currency === 'EUR' || currency === 'USD' || currency === 'GBP') {
    return `${symbols[currency]}${formatted}`
  }

  return `${formatted} ${currency}`
}

/**
 * Fetch exchange rates for multiple currencies in parallel.
 * Returns a Map with all requested currencies. Individual failures
 * use fallback rates so the Map is always fully populated.
 * SEK is always included with rate 1.
 */
export async function fetchMultipleRates(
  currencies: Currency[],
  date?: Date
): Promise<Map<Currency, ExchangeRate>> {
  const results = new Map<Currency, ExchangeRate>()

  // Always include SEK
  results.set('SEK', {
    currency: 'SEK',
    rate: 1,
    date: (date || new Date()).toISOString().split('T')[0],
  })

  const nonSek = currencies.filter(c => c !== 'SEK')
  if (nonSek.length === 0) return results

  const settled = await Promise.allSettled(
    nonSek.map(currency => fetchExchangeRate(currency, date))
  )

  for (let i = 0; i < nonSek.length; i++) {
    const currency = nonSek[i]
    const outcome = settled[i]

    if (outcome.status === 'fulfilled' && outcome.value) {
      results.set(currency, outcome.value)
    } else {
      // fetchExchangeRate already returns fallback on error,
      // but if it returned null or the promise rejected, use fallback
      results.set(currency, getFallbackRate(currency))
    }
  }

  return results
}

/**
 * Fetch exchange rates for a currency over a date range.
 * Uses the Riksbanken date-range endpoint. Returns a sorted array.
 */
export async function fetchRateRange(
  currency: Currency,
  fromDate: Date,
  toDate: Date
): Promise<ExchangeRate[]> {
  if (currency === 'SEK') {
    return [{
      currency: 'SEK',
      rate: 1,
      date: fromDate.toISOString().split('T')[0],
    }]
  }

  const seriesId = SERIES_IDS[currency]
  if (!seriesId) {
    log.error(`Unknown currency: ${currency}`)
    return []
  }

  const from = fromDate.toISOString().split('T')[0]
  const to = toDate.toISOString().split('T')[0]

  try {
    const url = `https://api.riksbank.se/swea/v1/Observations/${seriesId}/${from}/${to}`
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    })

    if (!response.ok) {
      log.error(`Failed to fetch rate range: ${response.status}`)
      return []
    }

    const data = await response.json()
    if (!Array.isArray(data)) return []

    return data
      .map((item: { date: string; value: string }) => ({
        currency,
        rate: parseFloat(item.value),
        date: item.date,
      }))
      .sort((a: ExchangeRate, b: ExchangeRate) => a.date.localeCompare(b.date))
  } catch (error) {
    log.error('Error fetching rate range:', error)
    return []
  }
}

/**
 * Fetch the latest available exchange rate for a currency.
 * Useful when today's rate hasn't been published yet.
 */
export async function fetchLatestRate(
  currency: Currency
): Promise<ExchangeRate | null> {
  if (currency === 'SEK') {
    return {
      currency: 'SEK',
      rate: 1,
      date: new Date().toISOString().split('T')[0],
    }
  }

  const seriesId = SERIES_IDS[currency]
  if (!seriesId) {
    log.error(`Unknown currency: ${currency}`)
    return null
  }

  try {
    const url = `https://api.riksbank.se/swea/v1/Observations/${seriesId}`
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    })

    if (!response.ok) {
      log.error(`Failed to fetch latest rate: ${response.status}`)
      return null
    }

    const data = await response.json()
    if (!Array.isArray(data) || data.length === 0) return null

    const latest = data[data.length - 1]
    return {
      currency,
      rate: parseFloat(latest.value),
      date: latest.date,
    }
  } catch (error) {
    log.error('Error fetching latest rate:', error)
    return getFallbackRate(currency)
  }
}
