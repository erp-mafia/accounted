import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fetchExchangeRate,
  readCachedRate,
  isExchangeRateTemporarilyUnavailable,
  resetExchangeRateStateForTests,
  setExchangeRateCacheWriterForTests,
  RIKSBANKEN_CURRENCIES,
} from '../riksbanken'

// Mock logger to suppress output; shared so a test can read the level used.
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => log,
}))

// The lookup keeps a per-process memo of fetched years and a cool-off after a
// refusal: both must start empty in every test.
beforeEach(() => {
  vi.restoreAllMocks()
  resetExchangeRateStateForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── A stand-in for Riksbanken's range endpoint ──────────────────────────
// No test in this file reaches the network: global fetch is replaced.

const DAY_MS = 86_400_000

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

interface SeriesDay {
  date: string
  value: number
}

/**
 * Banking days (Monday to Friday, minus holidays) in a range, each with its
 * own rate so a test can tell which day answered. The rate is a pure
 * function of the date, so separate range requests agree with each other.
 */
function publishedDays(base: number, from: string, to: string, holidays: string[] = []): SeriesDay[] {
  const days: SeriesDay[] = []
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay()
    if (weekday === 0 || weekday === 6 || holidays.includes(day)) continue
    const ordinal = Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS) % 1000
    days.push({ date: day, value: Math.round((base + ordinal * 0.0011) * 100000) / 100000 })
  }
  return days
}

/** What the lookup must answer for a date: that day, or the latest earlier one within 7 days. */
function expectedFor(days: SeriesDay[], date: string): SeriesDay | null {
  const earliest = addDays(date, -7)
  const candidates = days.filter((d) => d.date <= date && d.date >= earliest)
  return candidates.length > 0 ? candidates[candidates.length - 1] : null
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

interface RiksbankenStub {
  requests: string[]
  series: (currency: string) => SeriesDay[]
}

/**
 * Answers `/Observations/SEK<code>PMI/<from>/<to>` like the real API: the
 * published days in the range as JSON, or an empty 204.
 */
function stubRiksbanken(
  opts: { base?: Record<string, number>; publishedThrough?: string; holidays?: string[] } = {},
): RiksbankenStub {
  const requests: string[] = []
  const series = (currency: string) =>
    publishedDays(
      opts.base?.[currency] ?? 10,
      '2023-12-01',
      opts.publishedThrough ?? '2026-12-31',
      opts.holidays,
    )
  vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    requests.push(url)
    const match = url.match(/\/Observations\/SEK([A-Z]{3})PMI\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/)
    if (!match) return new Response('Not Found', { status: 404 })
    const [, currency, from, to] = match
    const days = series(currency).filter((d) => d.date >= from && d.date <= to)
    return days.length > 0 ? json(days) : new Response(null, { status: 204 })
  })
  return { requests, series }
}

type CacheRow = { rate: number | string; observation_date: string }

/**
 * A caller's client, as a user session: exchange_rates can be read, and an
 * insert is refused by RLS (migration 20260710100000).
 */
function userSessionClient(opts: { exact?: CacheRow | null; latest?: CacheRow | null } = {}) {
  const filters: Array<[string, string, unknown]> = []
  const upsert = vi.fn(async () => ({
    data: null,
    error: { code: '42501', message: 'permission denied for table exchange_rates' },
  }))
  const from = vi.fn(() => {
    let latestLookup = false
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters.push(['eq', column, value])
        return chain
      },
      lte: (column: string, value: unknown) => {
        latestLookup = true
        filters.push(['lte', column, value])
        return chain
      },
      gte: (column: string, value: unknown) => {
        filters.push(['gte', column, value])
        return chain
      },
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({
        data: (latestLookup ? opts.latest : opts.exact) ?? null,
        error: null,
      }),
      upsert,
    }
    return chain
  })
  return { client: { from } as never, from, upsert, filters }
}

/** The service-role writer, recording what it is asked to store. */
function serviceWriter(result: { data: null; error: { message: string } | null } = { data: null, error: null }) {
  const rows: Array<Record<string, unknown>> = []
  const options: unknown[] = []
  const tables: string[] = []
  const client = {
    from: vi.fn((table: string) => ({
      upsert: vi.fn(async (row: Record<string, unknown>, opts: unknown) => {
        tables.push(table)
        rows.push(row)
        options.push(opts)
        return result
      }),
    })),
  }
  setExchangeRateCacheWriterForTests(client as never)
  return { rows, options, tables }
}

describe('fetchExchangeRate', () => {
  it('returns rate 1 for SEK without fetching', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    const result = await fetchExchangeRate('SEK')

    expect(result).toEqual({
      currency: 'SEK',
      rate: 1,
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('asks for the whole calendar year of the currency in one range request', async () => {
    const riksbanken = stubRiksbanken({ base: { EUR: 11 } })

    const result = await fetchExchangeRate('EUR', new Date('2025-01-15'))

    const day = expectedFor(riksbanken.series('EUR'), '2025-01-15')!
    expect(day.date).toBe('2025-01-15')
    expect(result).toEqual({ currency: 'EUR', rate: day.value, date: '2025-01-15' })
    // Seven days before 1 January (so the first days of the year can look
    // back) to seven days after 31 December (so the last days get a later
    // observation).
    expect(riksbanken.requests).toEqual([
      'https://api.riksbank.se/swea/v1/Observations/SEKEURPMI/2024-12-25/2026-01-07',
    ])
  })

  it('parses a rate that arrives as a string', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(json([{ value: '11.42', date: '2025-01-15' }]))

    const result = await fetchExchangeRate('EUR', new Date('2025-01-15'))

    expect(result).toEqual({ currency: 'EUR', rate: 11.42, date: '2025-01-15' })
  })

  it('never sends the request through a shared HTTP cache', async () => {
    // One URL answers for a whole year: a stale copy would resolve yesterday
    // from a response fetched before yesterday's rate existed.
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(json([{ value: 11.42, date: '2025-01-15' }]))

    await fetchExchangeRate('EUR', new Date('2025-01-15'))

    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ cache: 'no-store' })
  })

  // ── Issue: a batch made one request per row and was rate-limited ────────

  describe('a batch of rows over different dates', () => {
    /** 18 dates spread over 2025, weekends and holidays among them. */
    const batchDates = Array.from({ length: 18 }, (_, i) => addDays('2025-01-04', i * 19))

    it('makes ONE request for 18 rows in one currency, and each row gets its own date', async () => {
      const riksbanken = stubRiksbanken({ base: { USD: 10 } })

      const results = []
      for (const date of batchDates) {
        results.push(await fetchExchangeRate('USD', new Date(date)))
      }

      expect(riksbanken.requests).toHaveLength(1)
      const seen = new Set<number>()
      for (let i = 0; i < batchDates.length; i++) {
        const expected = expectedFor(riksbanken.series('USD'), batchDates[i])!
        expect(results[i], batchDates[i]).toEqual({ currency: 'USD', rate: expected.value, date: expected.date })
        seen.add(results[i]!.rate)
      }
      // Not one rate stamped on every row: the dates differ, so do the rates.
      expect(seen.size).toBeGreaterThan(10)
    })

    it('bounds the requests by currencies times years, not by rows', async () => {
      const riksbanken = stubRiksbanken({ base: { USD: 10, EUR: 11 } })
      const dates = [...batchDates, ...batchDates.map((d) => d.replace('2025', '2024'))]

      for (const date of dates) {
        expect(await fetchExchangeRate('USD', new Date(date)), date).not.toBeNull()
        expect(await fetchExchangeRate('EUR', new Date(date)), date).not.toBeNull()
      }

      // 72 lookups, 4 requests: USD 2025, EUR 2025, USD 2024, EUR 2024.
      expect(riksbanken.requests).toHaveLength(4)
    })

    it('shares one request between lookups that run at the same time', async () => {
      // lib/transactions/ingest.ts resolves four (currency, date) pairs at once.
      const riksbanken = stubRiksbanken()

      const results = await Promise.all(batchDates.map((date) => fetchExchangeRate('USD', new Date(date))))

      expect(riksbanken.requests).toHaveLength(1)
      expect(results.every((r) => r !== null)).toBe(true)
    })

    it('still makes one request when the cache is empty and can be read but not written', async () => {
      // The reported setup: no bank feed, exchange_rates empty, rows approved
      // with a user session.
      const riksbanken = stubRiksbanken()
      const session = userSessionClient()

      for (const date of batchDates) {
        expect(await fetchExchangeRate('USD', new Date(date), session.client), date).not.toBeNull()
      }

      expect(riksbanken.requests).toHaveLength(1)
    })
  })

  // ── Weekends, holidays and dates without an observation ─────────────────

  describe('a date without an observation', () => {
    it('takes Friday for a Saturday and a Sunday', async () => {
      const riksbanken = stubRiksbanken()
      const friday = expectedFor(riksbanken.series('USD'), '2025-03-14')!

      const saturday = await fetchExchangeRate('USD', new Date('2025-03-15'))
      const sunday = await fetchExchangeRate('USD', new Date('2025-03-16'))

      expect(friday.date).toBe('2025-03-14')
      expect(saturday).toEqual({ currency: 'USD', rate: friday.value, date: '2025-03-14' })
      expect(sunday).toEqual({ currency: 'USD', rate: friday.value, date: '2025-03-14' })
    })

    it('takes the last observation before a run of holidays', async () => {
      const riksbanken = stubRiksbanken({ holidays: ['2025-12-24', '2025-12-25', '2025-12-26'] })
      const before = expectedFor(riksbanken.series('USD'), '2025-12-23')!

      // Wednesday to Sunday without an observation: five days back at most.
      for (const date of ['2025-12-24', '2025-12-25', '2025-12-26', '2025-12-27', '2025-12-28']) {
        expect(await fetchExchangeRate('USD', new Date(date)), date).toEqual({
          currency: 'USD',
          rate: before.value,
          date: '2025-12-23',
        })
      }
    })

    it('looks back across the turn of the year', async () => {
      const riksbanken = stubRiksbanken({ holidays: ['2024-12-31', '2025-01-01'] })
      const before = expectedFor(riksbanken.series('USD'), '2024-12-30')!

      const result = await fetchExchangeRate('USD', new Date('2025-01-01'))

      expect(result).toEqual({ currency: 'USD', rate: before.value, date: '2024-12-30' })
      expect(riksbanken.requests).toHaveLength(1)
    })

    it('looks back seven days and no further', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(json([{ value: 10.5, date: '2025-05-02' }]))

      // Exactly seven days after the only observation: still answered.
      expect(await fetchExchangeRate('USD', new Date('2025-05-09'))).toEqual({
        currency: 'USD',
        rate: 10.5,
        date: '2025-05-02',
      })
      // Eight days after: that observation is not this date's rate.
      expect(await fetchExchangeRate('USD', new Date('2025-05-10'))).toBeNull()
    })

    it('returns null, not a made-up rate, when Riksbanken has nothing for the year', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

      const result = await fetchExchangeRate('USD', new Date('2025-05-10'))

      expect(result).toBeNull()
      // A rate that does not exist is not a temporary state: nothing to wait for.
      expect(isExchangeRateTemporarilyUnavailable('USD')).toBe(false)
      // And the empty answer is remembered, so the next row does not ask again.
      expect(await fetchExchangeRate('USD', new Date('2025-06-10'))).toBeNull()
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })
  })

  // ── Riksbanken's rate limit (HTTP 429) and outages ──────────────────────

  describe('when Riksbanken rate-limits or fails', () => {
    it('waits out a short Retry-After and retries once: the row gets its rate', async () => {
      vi.useFakeTimers()
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(new Response('Rate limit is exceeded', { status: 429, headers: { 'retry-after': '2' } }))
        .mockResolvedValueOnce(json([{ value: 11.42, date: '2025-01-15' }]))

      const promise = fetchExchangeRate('EUR', new Date('2025-01-15'))
      await vi.advanceTimersByTimeAsync(1999)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)

      expect(await promise).toEqual({ currency: 'EUR', rate: 11.42, date: '2025-01-15' })
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(isExchangeRateTemporarilyUnavailable('EUR')).toBe(false)
    })

    it('retries once after a 429 without a Retry-After header', async () => {
      vi.useFakeTimers()
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(new Response('Too Many Requests', { status: 429 }))
        .mockResolvedValueOnce(json([{ value: 11.42, date: '2025-01-15' }]))

      const promise = fetchExchangeRate('EUR', new Date('2025-01-15'))
      await vi.runAllTimersAsync()

      expect(await promise).toEqual({ currency: 'EUR', rate: 11.42, date: '2025-01-15' })
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('retries a 5xx once and then gives up for a moment', async () => {
      vi.useFakeTimers()
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('Bad Gateway', { status: 502 }))

      const promise = fetchExchangeRate('EUR', new Date('2025-01-15'))
      await vi.runAllTimersAsync()

      expect(await promise).toBeNull()
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      expect(isExchangeRateTemporarilyUnavailable('EUR')).toBe(true)
    })

    it('does not wait out or retry a long Retry-After, and the rest of the batch fails fast', async () => {
      vi.useFakeTimers()
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response('Rate limit is exceeded', { status: 429, headers: { 'retry-after': '54' } }))

      // No timer is advanced: the answer must not depend on a wait.
      const first = await fetchExchangeRate('USD', new Date('2025-07-29'))

      expect(first).toBeNull()
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(isExchangeRateTemporarilyUnavailable('USD')).toBe(true)

      // Fifteen more rows, other dates and another currency: no request each,
      // no five seconds each.
      for (let i = 0; i < 15; i++) {
        expect(await fetchExchangeRate(i % 2 ? 'USD' : 'EUR', new Date(addDays('2024-03-01', i * 9)))).toBeNull()
      }
      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('is not a permanent refusal: the same lookup works once the wait has passed', async () => {
      vi.useFakeTimers()
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(new Response('Rate limit is exceeded', { status: 429, headers: { 'retry-after': '54' } }))
        .mockResolvedValue(json([{ value: 9.87, date: '2025-07-29' }]))

      expect(await fetchExchangeRate('USD', new Date('2025-07-29'))).toBeNull()

      await vi.advanceTimersByTimeAsync(53_000)
      expect(isExchangeRateTemporarilyUnavailable('USD')).toBe(true)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(isExchangeRateTemporarilyUnavailable('USD')).toBe(false)

      expect(await fetchExchangeRate('USD', new Date('2025-07-29'))).toEqual({
        currency: 'USD',
        rate: 9.87,
        date: '2025-07-29',
      })
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('caps the wait it remembers at one minute', async () => {
      vi.useFakeTimers()
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response('Rate limit is exceeded', { status: 429, headers: { 'retry-after': '86400' } }),
      )

      await fetchExchangeRate('USD', new Date('2025-07-29'))
      await vi.advanceTimersByTimeAsync(60_000)

      expect(isExchangeRateTemporarilyUnavailable('USD')).toBe(false)
    })

    it('returns null on a network error: never a hardcoded rate, never 1', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network error'))

      const result = await fetchExchangeRate('EUR', new Date('2025-01-15'))

      expect(result).toBeNull()
      expect(isExchangeRateTemporarilyUnavailable('EUR')).toBe(true)
    })

    it('falls back to a cached observation within the look-back', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'))
      const session = userSessionClient({ latest: { rate: 11.38, observation_date: '2025-01-10' } })

      const result = await fetchExchangeRate('EUR', new Date('2025-01-15'), session.client)

      // An honest, dated observation: not a hardcoded 11.5.
      expect(result).toEqual({ currency: 'EUR', rate: 11.38, date: '2025-01-10' })
      // Bounded like a live answer: an observation more than seven days
      // before the date is another period's rate and must not be booked.
      expect(session.filters).toContainEqual(['lte', 'rate_date', '2025-01-15'])
      expect(session.filters).toContainEqual(['gte', 'observation_date', '2025-01-08'])
    })

    it('returns null when Riksbanken is down and the cache has nothing recent', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'))
      const session = userSessionClient()

      const result = await fetchExchangeRate('EUR', new Date('2025-01-15'), session.client)

      expect(result).toBeNull()
    })
  })

  // ── The shared exchange_rates cache ─────────────────────────────────────

  describe('with the exchange_rates cache (supabase passed)', () => {
    it('serves a cache hit without touching Riksbanken', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch')
      const session = userSessionClient({ exact: { rate: 11.11, observation_date: '2025-01-15' } })

      const result = await fetchExchangeRate('EUR', new Date('2025-01-15'), session.client)

      expect(result).toEqual({ currency: 'EUR', rate: 11.11, date: '2025-01-15' })
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(session.filters).toEqual([
        ['eq', 'currency', 'EUR'],
        ['eq', 'rate_date', '2025-01-15'],
      ])
    })

    it('writes a fetched rate with the service-role writer, never with the client the caller holds', async () => {
      // The cause of the report: with a user session the write was refused by
      // RLS and dropped, so the cache only ever filled from the bank sync.
      stubRiksbanken({ base: { EUR: 11 } })
      const session = userSessionClient()
      const writer = serviceWriter()

      const result = await fetchExchangeRate('EUR', new Date('2025-01-15'), session.client)

      expect(session.upsert).not.toHaveBeenCalled()
      expect(writer.tables).toEqual(['exchange_rates'])
      expect(writer.rows).toEqual([
        {
          currency: 'EUR',
          rate_date: '2025-01-15',
          rate: result!.rate,
          observation_date: '2025-01-15',
          source: 'riksbanken',
        },
      ])
      // First write wins and a stored row is never overwritten.
      expect(writer.options).toEqual([{ onConflict: 'currency,rate_date', ignoreDuplicates: true }])
    })

    it('stores a weekend under its own date with the observation that answered it', async () => {
      stubRiksbanken()
      const writer = serviceWriter()

      await fetchExchangeRate('USD', new Date('2025-03-16'), userSessionClient().client)

      expect(writer.rows).toHaveLength(1)
      expect(writer.rows[0]).toMatchObject({ rate_date: '2025-03-16', observation_date: '2025-03-14' })
    })

    it('fills the cache row by row through a batch, from one request', async () => {
      const riksbanken = stubRiksbanken()
      const writer = serviceWriter()
      const session = userSessionClient()
      const dates = ['2025-02-03', '2025-04-17', '2025-07-29', '2025-09-30']

      for (const date of dates) await fetchExchangeRate('USD', new Date(date), session.client)

      expect(riksbanken.requests).toHaveLength(1)
      expect(writer.rows.map((r) => r.rate_date)).toEqual(dates)
    })

    it('does NOT store a date Riksbanken has not published on or past yet', async () => {
      // Thursday is the latest published day. Friday (today, before
      // publication) resolves to Thursday, but storing that would answer
      // Friday with Thursday's rate for every company, for good: the row is
      // never updated.
      stubRiksbanken({ publishedThrough: '2025-06-12' })
      const writer = serviceWriter()
      const session = userSessionClient()

      const friday = await fetchExchangeRate('USD', new Date('2025-06-13'), session.client)
      const nextWeek = await fetchExchangeRate('USD', new Date('2025-06-18'), session.client)

      expect(friday).toMatchObject({ date: '2025-06-12' })
      expect(nextWeek).toMatchObject({ date: '2025-06-12' })
      expect(writer.rows).toEqual([])

      // The published day itself is settled and is stored.
      await fetchExchangeRate('USD', new Date('2025-06-12'), session.client)
      expect(writer.rows.map((r) => r.rate_date)).toEqual(['2025-06-12'])
    })

    it('still returns the rate when the cache write fails', async () => {
      stubRiksbanken()
      serviceWriter({ data: null, error: { message: 'connection reset' } })

      const result = await fetchExchangeRate('USD', new Date('2025-03-14'), userSessionClient().client)

      expect(result).toMatchObject({ currency: 'USD', date: '2025-03-14' })
    })

    it('still returns the rate when the cache writer throws', async () => {
      stubRiksbanken()
      setExchangeRateCacheWriterForTests({
        from: () => {
          throw new Error('connection refused')
        },
      } as never)

      const result = await fetchExchangeRate('USD', new Date('2025-03-14'), userSessionClient().client)

      expect(result).toMatchObject({ currency: 'USD', date: '2025-03-14' })
    })

    it('still returns the rate when no service-role writer is configured', async () => {
      stubRiksbanken()
      setExchangeRateCacheWriterForTests(null)
      const session = userSessionClient()

      const result = await fetchExchangeRate('USD', new Date('2025-03-14'), session.client)

      expect(result).toMatchObject({ currency: 'USD', date: '2025-03-14' })
      expect(session.upsert).not.toHaveBeenCalled()
    })

    it('neither reads nor writes the cache when no client is passed (dry runs rely on it)', async () => {
      stubRiksbanken()
      const writer = serviceWriter()

      const result = await fetchExchangeRate('USD', new Date('2025-03-14'))

      expect(result).toMatchObject({ currency: 'USD', date: '2025-03-14' })
      expect(writer.rows).toEqual([])
    })
  })

  // ── Issue: rates for every currency Riksbanken publishes ───────────────

  describe('currencies', () => {
    it.each(['EUR', 'USD', 'GBP', 'NOK', 'DKK', 'CHF', 'CAD', 'PLN', 'AUD', 'JPY', 'CZK', 'HUF', 'NZD', 'ZAR'])(
      'fetches %s from its SEK<code>PMI series',
      async (currency) => {
        const riksbanken = stubRiksbanken()

        const result = await fetchExchangeRate(currency, new Date('2025-01-15'))

        expect(result).toMatchObject({ currency, date: '2025-01-15' })
        expect(riksbanken.requests[0]).toContain(`/Observations/SEK${currency}PMI/`)
      },
    )

    it('keeps a rate far below 1 as published (SEK per one unit, no scaling)', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce(json([{ value: 0.06297, date: '2025-01-15' }]))

      const result = await fetchExchangeRate('JPY', new Date('2025-01-15'))

      expect(result).toEqual({ currency: 'JPY', rate: 0.06297, date: '2025-01-15' })
    })

    it('answers a closed series for the dates it was published', async () => {
      // BGN stopped at the end of 2025: earlier rows still get their rate,
      // later ones get none.
      stubRiksbanken({ publishedThrough: '2025-12-30' })

      expect(await fetchExchangeRate('BGN', new Date('2025-11-20'))).toMatchObject({ date: '2025-11-20' })
      expect(await fetchExchangeRate('BGN', new Date('2026-03-02'))).toBeNull()
    })

    it.each(['XXX', 'usd', 'SEKUSD', '../x', ''])('makes no request for %j, which Riksbanken has no series for', async (currency) => {
      const fetchSpy = vi.spyOn(global, 'fetch')

      const result = await fetchExchangeRate(currency, new Date('2025-01-15'))

      expect(result).toBeNull()
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it.each(['ALL', 'UAH'])(
      'answers %s, a real currency without a Riksbanken series, with null and no error: no request, no cache read',
      async (currency) => {
        // Albanian lek receipts in the inbox (prod 2026-10-21): every bank
        // match check of one logged an error that paged, for an answer.
        log.error.mockClear()
        log.info.mockClear()
        const fetchSpy = vi.spyOn(global, 'fetch')
        const from = vi.fn()

        const result = await fetchExchangeRate(currency, new Date('2026-08-23'), { from } as never)

        expect(result).toBeNull()
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(from).not.toHaveBeenCalled()
        expect(log.error).not.toHaveBeenCalled()
        expect(log.info).toHaveBeenCalledWith(expect.any(String), { currency })
        expect(isExchangeRateTemporarilyUnavailable(currency)).toBe(false)
      },
    )

    it('never calls an unknown currency temporarily unavailable', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network error'))
      await fetchExchangeRate('EUR', new Date('2025-01-15'))

      expect(isExchangeRateTemporarilyUnavailable('EUR')).toBe(true)
      expect(isExchangeRateTemporarilyUnavailable('XXX')).toBe(false)
    })

    it('lists codes that are distinct, upper-case ISO shapes, and not SEK', () => {
      expect(new Set(RIKSBANKEN_CURRENCIES).size).toBe(RIKSBANKEN_CURRENCIES.length)
      for (const code of RIKSBANKEN_CURRENCIES) expect(code).toMatch(/^[A-Z]{3}$/)
      expect(RIKSBANKEN_CURRENCIES).not.toContain('SEK')
    })
  })
})

// Exported so the currency.rate route can hit the exchange_rates cache in
// parallel with its sandbox guard instead of always going through
// fetchExchangeRate's sequential path.
describe('readCachedRate', () => {
  it('maps an exact-date cache row to an ExchangeRate', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      // rate arrives as a numeric string from PostgREST: must be Number()ed.
      data: { rate: '11.25', observation_date: '2025-01-14' },
      error: null,
    })
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle,
      })),
    } as never

    const result = await readCachedRate(supabase, 'EUR', '2025-01-15')

    expect(result).toEqual({ currency: 'EUR', rate: 11.25, date: '2025-01-14' })
  })

  it('returns null when the cache has no row for the date', async () => {
    const supabase = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
    } as never

    const result = await readCachedRate(supabase, 'EUR', '2025-01-15')

    expect(result).toBeNull()
  })

  it('swallows thrown client errors and returns null (best-effort cache)', async () => {
    const supabase = {
      from: vi.fn(() => {
        throw new Error('connection refused')
      }),
    } as never

    const result = await readCachedRate(supabase, 'EUR', '2025-01-15')

    expect(result).toBeNull()
  })
})
