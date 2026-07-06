import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  fetchExchangeRate,
  fetchMultipleRates,
  fetchRateRange,
  fetchLatestRate,
  convertToSEK,
  formatCurrencyAmount,
} from '../riksbanken'

// Mock logger to suppress output
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

describe('fetchExchangeRate', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

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

  it('parses EUR rate from API response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify([{ value: '11.42', date: '2025-01-15' }]), { status: 200 })
    )

    const result = await fetchExchangeRate('EUR', new Date('2025-01-15'))

    expect(result).toEqual({
      currency: 'EUR',
      rate: 11.42,
      date: '2025-01-15',
    })
  })

  it('returns null on fetch error — never a hardcoded rate on the booking path', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network error'))

    const result = await fetchExchangeRate('EUR')

    expect(result).toBeNull()
  })

  it('tries fallback URL when primary returns 404 (no observation for the date)', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([
          { value: '10.80', date: '2025-01-13' },
          { value: '10.85', date: '2025-01-14' },
        ]), { status: 200 })
      )

    const result = await fetchExchangeRate('USD', new Date('2025-01-15'))

    expect(result).toEqual({
      currency: 'USD',
      rate: 10.85,
      date: '2025-01-14',
    })
  })

  it('retries once on 429 and does NOT fire the range-fallback request', async () => {
    vi.useFakeTimers()
    try {
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(
          new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '1' } })
        )
        .mockResolvedValueOnce(new Response('Too Many Requests', { status: 429 }))

      const promise = fetchExchangeRate('EUR', new Date('2025-01-15'))
      await vi.runAllTimersAsync()
      const result = await promise

      // Two calls to the SAME single-day URL (initial + retry); the 7-day
      // range endpoint is never hit — the old code fired it on 429 and
      // doubled the load on an already rate-limited API.
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      const urls = fetchSpy.mock.calls.map((c) => String(c[0]))
      expect(urls[0]).toBe(urls[1])
      expect(urls[0]).toContain('/2025-01-15/2025-01-15')
      expect(result).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers when the 429 retry succeeds', async () => {
    vi.useFakeTimers()
    try {
      vi.spyOn(global, 'fetch')
        .mockResolvedValueOnce(new Response('Too Many Requests', { status: 429 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify([{ value: '11.42', date: '2025-01-15' }]), { status: 200 })
        )

      const promise = fetchExchangeRate('EUR', new Date('2025-01-15'))
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result).toEqual({ currency: 'EUR', rate: 11.42, date: '2025-01-15' })
    } finally {
      vi.useRealTimers()
    }
  })

  describe('with the persistent exchange_rates cache (supabase passed)', () => {
    type CacheRow = { rate: number; observation_date: string }

    function makeSupabase(opts: {
      exactHit?: CacheRow | null
      latestHit?: CacheRow | null
      onUpsert?: (row: Record<string, unknown>) => void
    }) {
      // .maybeSingle() terminates both the exact lookup and the latest
      // lookup. Shared across from() calls so the once-queue holds: the
      // first maybeSingle in a test is the exact lookup, subsequent ones
      // are the latest-cached lookup.
      const maybeSingle = vi
        .fn()
        .mockResolvedValueOnce({ data: opts.exactHit ?? null, error: null })
        .mockResolvedValue({ data: opts.latestHit ?? null, error: null })
      return {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          lte: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          maybeSingle,
          upsert: vi.fn((row: Record<string, unknown>) => {
            opts.onUpsert?.(row)
            return Promise.resolve({ data: null, error: null })
          }),
        })),
      } as never
    }

    it('serves a cache hit without touching Riksbanken', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch')
      const supabase = makeSupabase({ exactHit: { rate: 11.11, observation_date: '2025-01-15' } })

      const result = await fetchExchangeRate('EUR', new Date('2025-01-15'), supabase)

      expect(result).toEqual({ currency: 'EUR', rate: 11.11, date: '2025-01-15' })
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('writes a fetched rate into the cache', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify([{ value: '11.42', date: '2025-01-15' }]), { status: 200 })
      )
      let upserted: Record<string, unknown> | undefined
      const supabase = makeSupabase({ onUpsert: (row) => (upserted = row) })

      const result = await fetchExchangeRate('EUR', new Date('2025-01-15'), supabase)

      expect(result).toEqual({ currency: 'EUR', rate: 11.42, date: '2025-01-15' })
      expect(upserted).toMatchObject({
        currency: 'EUR',
        rate_date: '2025-01-15',
        rate: 11.42,
        observation_date: '2025-01-15',
        source: 'riksbanken',
      })
    })

    it('falls back to the most recent cached observation when Riksbanken is down', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'))
      const supabase = makeSupabase({
        exactHit: null,
        latestHit: { rate: 11.38, observation_date: '2025-01-10' },
      })

      const result = await fetchExchangeRate('EUR', new Date('2025-01-15'), supabase)

      // An honest, dated observation — not a hardcoded 11.5.
      expect(result).toEqual({ currency: 'EUR', rate: 11.38, date: '2025-01-10' })
    })

    it('returns null when Riksbanken is down and the cache is empty', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'))
      const supabase = makeSupabase({ exactHit: null, latestHit: null })

      const result = await fetchExchangeRate('EUR', new Date('2025-01-15'), supabase)

      expect(result).toBeNull()
    })
  })
})

describe('fetchMultipleRates', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns Map with all requested currencies', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ value: '11.42', date: '2025-01-15' }]), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ value: '10.50', date: '2025-01-15' }]), { status: 200 })
      )

    const result = await fetchMultipleRates(['EUR', 'USD'])

    expect(result.size).toBe(3) // EUR, USD, + always SEK
    expect(result.get('SEK')!.rate).toBe(1)
    expect(result.get('EUR')!.rate).toBe(11.42)
    expect(result.get('USD')!.rate).toBe(10.50)
  })

  it('handles partial failure: returns fallback for failed currencies', async () => {
    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ value: '11.42', date: '2025-01-15' }]), { status: 200 })
      )
      .mockRejectedValueOnce(new Error('Network error'))

    const result = await fetchMultipleRates(['EUR', 'GBP'])

    expect(result.size).toBe(3)
    expect(result.get('EUR')!.rate).toBe(11.42)
    // GBP gets fallback rate (from the catch in fetchExchangeRate)
    expect(result.get('GBP')).toBeDefined()
    expect(result.get('GBP')!.rate).toBeGreaterThan(0)
  })

  it('returns only SEK when given empty array', async () => {
    const result = await fetchMultipleRates([])
    expect(result.size).toBe(1)
    expect(result.get('SEK')!.rate).toBe(1)
  })

  it('handles SEK in the input array without duplicate fetch', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify([{ value: '11.42', date: '2025-01-15' }]), { status: 200 })
    )

    const result = await fetchMultipleRates(['SEK', 'EUR'])

    expect(result.size).toBe(2)
    expect(result.get('SEK')!.rate).toBe(1)
    expect(result.get('EUR')!.rate).toBe(11.42)
  })
})

describe('fetchRateRange', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns sorted array of rates', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify([
        { value: '11.40', date: '2025-01-13' },
        { value: '11.45', date: '2025-01-15' },
        { value: '11.42', date: '2025-01-14' },
      ]), { status: 200 })
    )

    const result = await fetchRateRange(
      'EUR',
      new Date('2025-01-13'),
      new Date('2025-01-15')
    )

    expect(result).toHaveLength(3)
    expect(result[0].date).toBe('2025-01-13')
    expect(result[1].date).toBe('2025-01-14')
    expect(result[2].date).toBe('2025-01-15')
  })

  it('returns [rate:1] for SEK', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    const result = await fetchRateRange(
      'SEK',
      new Date('2025-01-13'),
      new Date('2025-01-15')
    )

    expect(result).toHaveLength(1)
    expect(result[0].rate).toBe(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns empty array on error', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network error'))

    const result = await fetchRateRange(
      'EUR',
      new Date('2025-01-13'),
      new Date('2025-01-15')
    )

    expect(result).toEqual([])
  })

  it('returns empty array on non-200 response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('Not Found', { status: 404 })
    )

    const result = await fetchRateRange(
      'EUR',
      new Date('2025-01-13'),
      new Date('2025-01-15')
    )

    expect(result).toEqual([])
  })
})

describe('fetchLatestRate', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the last item from API response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify([
        { value: '11.40', date: '2025-01-13' },
        { value: '11.42', date: '2025-01-14' },
        { value: '11.45', date: '2025-01-15' },
      ]), { status: 200 })
    )

    const result = await fetchLatestRate('EUR')

    expect(result).toEqual({
      currency: 'EUR',
      rate: 11.45,
      date: '2025-01-15',
    })
  })

  it('returns rate 1 for SEK', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    const result = await fetchLatestRate('SEK')

    expect(result).toEqual({
      currency: 'SEK',
      rate: 1,
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns fallback on error', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network error'))

    const result = await fetchLatestRate('EUR')

    expect(result).not.toBeNull()
    expect(result!.currency).toBe('EUR')
    expect(result!.rate).toBeGreaterThan(0)
  })

  it('returns null on empty API response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify([]), { status: 200 })
    )

    const result = await fetchLatestRate('EUR')

    expect(result).toBeNull()
  })
})

describe('convertToSEK', () => {
  it('converts amount correctly', () => {
    expect(convertToSEK(100, 11.42)).toBe(1142)
  })

  it('handles zero amount', () => {
    expect(convertToSEK(0, 11.42)).toBe(0)
  })
})

describe('formatCurrencyAmount', () => {
  it('formats EUR with symbol prefix', () => {
    const result = formatCurrencyAmount(1234.56, 'EUR')
    // sv-SE uses non-breaking space as thousands separator
    expect(result).toContain('€')
    expect(result).toContain('1')
    expect(result).toContain('234')
  })

  it('formats SEK with currency suffix', () => {
    const result = formatCurrencyAmount(1234.56, 'SEK')
    expect(result).toContain('SEK')
  })

  it('formats NOK with currency suffix', () => {
    const result = formatCurrencyAmount(100, 'NOK')
    expect(result).toContain('NOK')
  })
})
