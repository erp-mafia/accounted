import { describe, expect, it } from 'vitest'
import { allocateLedgers, freeLedgerSlots, ledgerName, ledgerOptions } from '../ledger'

describe('allocateLedgers', () => {
  it('first SEK account gets 1930, the next the first free slot, EUR its default', () => {
    const out = allocateLedgers(
      [
        { uid: 'a', currency: 'SEK' },
        { uid: 'b', currency: 'SEK' },
        { uid: 'c', currency: 'EUR' },
      ],
      [],
    )
    expect(out).toEqual({ a: '1930', b: '1931', c: '1932' })
  })

  it('never reuses a ledger the company already has', () => {
    const out = allocateLedgers([{ uid: 'a', currency: 'SEK' }], ['1930', '1931'])
    expect(out.a).toBe('1932')
    expect(freeLedgerSlots(['1930', '1931', '1932', '1933', '1934'])[0]).toBe('1935')
  })

  it('a user pick wins when it is free, otherwise the rule applies', () => {
    const out = allocateLedgers(
      [
        { uid: 'a', currency: 'SEK' },
        { uid: 'b', currency: 'SEK' },
      ],
      [],
      { a: '1940', b: '1940' },
    )
    expect(out).toEqual({ a: '1940', b: '1930' })
  })

  it('lowercase currency codes still find their default', () => {
    expect(allocateLedgers([{ uid: 'a', currency: 'usd' }], []).a).toBe('1933')
  })
})

describe('ledgerOptions and names', () => {
  it('lists the default and the free slots, current first when it is elsewhere', () => {
    const opts = ledgerOptions('SEK', ['1930', '1932'], '1931')
    expect(opts[0]).toBe('1931')
    expect(opts).not.toContain('1930')
    expect(opts).toContain('1935')
  })

  it('falls back to a currency name for unnamed slots', () => {
    expect(ledgerName('1930', 'SEK')).toBe('Företagskonto')
    expect(ledgerName('1937', 'sek')).toBe('Bankkonto SEK')
    expect(ledgerName('1937', 'SEK', { '1937': 'Lönekonto' })).toBe('Lönekonto')
  })
})
