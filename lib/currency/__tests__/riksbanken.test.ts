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

  it('returns fallback rate on fetch error', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network error'))

    const result = await fetchExchangeRate('EUR')

    expect(result).not.toBeNull()
    expect(result!.currency).toBe('EUR')
    expect(result!.rate).toBeGreaterThan(0)
  })

  it('tries fallback URL when primary returns non-200', async () => {
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
