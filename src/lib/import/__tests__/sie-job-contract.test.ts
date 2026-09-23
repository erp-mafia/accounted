import { describe, expect, it } from 'vitest'
import { chunkSIEEntries, hashSIEPayload, resumedSIEState, SIE_LIMITS, sieRetryDelaySeconds } from '../sie-job-contract'

describe('durable SIE import boundaries', () => {
  it('resumes a committed middle chunk without finalizing the unfinished file', () => {
    expect(resumedSIEState('vouchers', 7, 30)).toBe('running')
    expect(resumedSIEState('vouchers', 30, 30)).toBe('finalizing')
    expect(resumedSIEState('undo', 30, 30)).toBe('undoing')
    expect(resumedSIEState('prepare', 0, 0)).toBe('preparing')
  })

  it('bounds line-heavy vouchers without splitting a voucher', () => {
    const entries = [800, 800, 800].map((count, i) => ({ sourceId: `A${i}`, lines: Array(count).fill({ account: '1930' }) }))
    const chunks = [...chunkSIEEntries(entries)]
    expect(chunks.map(c => c.length)).toEqual([2, 1])
    expect(chunks.flat()).toEqual(entries)
  })

  it('bounds UTF-8 bytes and names a single oversized voucher', () => {
    const entry = { sourceId: 'A17', lines: [{ text: 'å'.repeat(SIE_LIMITS.chunkBytes / 2) }] }
    expect(() => [...chunkSIEEntries([entry])]).toThrow('A17')
    const smaller = { sourceId: 'A18', lines: [{ text: 'å'.repeat(300_000) }] }
    expect([...chunkSIEEntries([smaller, smaller])].map(c => c.length)).toEqual([1, 1])
  })

  it('splits a 6000-voucher file without dropping or duplicating ordinals', () => {
    const entries = Array.from({ length: 6000 }, (_, i) => ({ sourceId: `A${i + 1}`, lines: [{}, {}] }))
    const chunks = [...chunkSIEEntries(entries)]
    expect(chunks).toHaveLength(30)
    expect(chunks.flat()).toEqual(entries)
  })

  it('matches identical objects but detects changed accounting content', () => {
    expect(hashSIEPayload({ account: '1930', amount: 10 })).toBe(hashSIEPayload({ amount: 10, account: '1930' }))
    expect(hashSIEPayload({ account: '1930', amount: 10 })).not.toBe(hashSIEPayload({ account: '1940', amount: 10 }))
    expect(hashSIEPayload([1, 2])).not.toBe(hashSIEPayload([2, 1]))
  })

  it('backs off exhausted retries rather than retrying a poisoned job every minute', () => {
    expect([1, 2, 3, 4].map(sieRetryDelaySeconds)).toEqual([15, 30, 60, 120])
    expect(sieRetryDelaySeconds(100)).toBe(3600)
  })
})
