import { describe, expect, it } from 'vitest'
import { rateLimitMessages, retryAfterSeconds } from '../rate-limit-message'

const NOW = Date.parse('2026-09-20T10:00:00Z') // 12:00 in Stockholm

describe('rateLimitMessages', () => {
  it('names the Stockholm clock time, as "at the earliest", and says no renewal is needed', () => {
    const { sv, en } = rateLimitMessages(NOW + 60 * 60_000, NOW)
    expect(sv).toBe(
      'Banken begränsar just nu hur ofta vi får hämta transaktioner. Försök igen tidigast 13:00. Anslutningen behöver inte förnyas.',
    )
    expect(en).toContain('Try again at 13:00 (Swedish time) at the earliest.')
  })

  it('adds the day when the cooldown ends on another Stockholm day', () => {
    expect(rateLimitMessages(NOW + 20 * 60 * 60_000, NOW).sv).toContain('Försök igen tidigast 21 sep. 08:00.')
  })
})

describe('retryAfterSeconds', () => {
  it('rounds up and never answers below one second', () => {
    expect(retryAfterSeconds(NOW + 1500, NOW)).toBe(2)
    expect(retryAfterSeconds(NOW - 5000, NOW)).toBe(1)
  })
})
