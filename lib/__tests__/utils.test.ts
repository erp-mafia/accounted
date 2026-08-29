import { describe, it, expect } from 'vitest'
import { swedishToday, formatCurrency, withTimeout } from '../utils'

describe('swedishToday', () => {
  it('formats the date as ISO yyyy-MM-dd with a Swedish weekday', () => {
    // 2026-01-01 is a Thursday → "torsdag". Noon UTC keeps us clear of any
    // midnight boundary so the assertion is timezone-stable.
    expect(swedishToday(new Date('2026-01-01T12:00:00Z'))).toBe('2026-01-01 (torsdag)')
  })

  it('reports the date in Europe/Stockholm, not UTC', () => {
    // 23:30 UTC on 2026-05-26 is already 01:30 on 2026-05-27 in Stockholm
    // (CEST, UTC+2). A naive UTC date would read the day before: the off-by-one
    // we explicitly format around for users near midnight.
    expect(swedishToday(new Date('2026-05-26T23:30:00Z'))).toBe('2026-05-27 (onsdag)')
  })

  it('omits clock time so the cached prompt prefix stays stable across a day', () => {
    const morning = swedishToday(new Date('2026-05-27T06:00:00Z'))
    const evening = swedishToday(new Date('2026-05-27T18:00:00Z'))
    expect(morning).toBe(evening)
    expect(morning).not.toMatch(/\d{2}:\d{2}/)
  })
})

describe('formatCurrency', () => {
  it('falls back to SEK for a NULL currency instead of throwing', () => {
    // transactions.currency is nullable and NULL is legacy for the 'SEK'
    // column default (migration 20260726100000), but the Transaction type
    // declares it required. Intl throws RangeError on `currency: null`, and
    // one such row used to blank the whole transactions list.
    expect(() => formatCurrency(1234.5, null)).not.toThrow()
    expect(formatCurrency(1234.5, null)).toBe(formatCurrency(1234.5, 'SEK'))
  })

  it('falls back to SEK for undefined and for an empty string', () => {
    expect(formatCurrency(10, undefined)).toBe(formatCurrency(10, 'SEK'))
    expect(formatCurrency(10, '')).toBe(formatCurrency(10, 'SEK'))
    expect(formatCurrency(10)).toBe(formatCurrency(10, 'SEK'))
  })

  it('still honours a real currency code', () => {
    expect(formatCurrency(10, 'EUR')).toContain('€')
  })
})

describe('withTimeout', () => {
  it('resolves with the promise value when it settles in time', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 1000)
    expect(result).toBe('ok')
  })

  it('rejects when the promise exceeds the deadline', async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 200))
    await expect(withTimeout(slow, 50)).rejects.toThrow('Timed out after 50ms')
  })

  it('rejects when the promise itself rejects', async () => {
    const failing = Promise.reject(new Error('boom'))
    await expect(withTimeout(failing, 1000)).rejects.toThrow('boom')
  })
})
