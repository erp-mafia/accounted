import { describe, expect, it } from 'vitest'
import { allocateLedgers, freeLedgerSlots, ledgerClaims, ledgerName, ledgerOptions } from '../ledger'

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

describe('a manual row on the currency default does not push the bank account off it', () => {
  // The seeded 1930 row (or the bank account an SIE import brought) has no
  // bank connection. The server promotes it in place, so the preview, which
  // PATCH /accounts sends as an explicit mapping, must pick 1930 too.
  const cashAccounts = [
    { ledger_account: '1930', bank_connection_id: null, enabled: true },
    { ledger_account: '1910', bank_connection_id: null, enabled: true },
  ]

  it('first SEK account keeps 1930 when only a manual row holds it', () => {
    const { used, connected } = ledgerClaims(cashAccounts, 'conn-new')
    expect(connected).toEqual([])
    expect(allocateLedgers([{ uid: 'a', currency: 'SEK' }], used, {}, connected)).toEqual({ a: '1930' })
  })

  it('the server preset 1930 survives the preview', () => {
    const { used, connected } = ledgerClaims(cashAccounts, 'conn-new')
    expect(allocateLedgers([{ uid: 'a', currency: 'SEK' }], used, { a: '1930' }, connected)).toEqual({ a: '1930' })
  })

  it('a second SEK account overflows past every existing row', () => {
    const { used, connected } = ledgerClaims(
      [...cashAccounts, { ledger_account: '1931', bank_connection_id: null, enabled: true }],
      'conn-new',
    )
    expect(
      allocateLedgers([{ uid: 'a', currency: 'SEK' }, { uid: 'b', currency: 'SEK' }], used, {}, connected),
    ).toEqual({ a: '1930', b: '1932' })
  })

  it('another live connection on 1930 still blocks it', () => {
    const { used, connected } = ledgerClaims(
      [{ ledger_account: '1930', bank_connection_id: 'conn-old', enabled: true }],
      'conn-new',
    )
    expect(connected).toEqual(['1930'])
    expect(allocateLedgers([{ uid: 'a', currency: 'SEK' }], used, { a: '1930' }, connected)).toEqual({ a: '1931' })
  })

  it('a disabled row of another connection does not block it', () => {
    const { used, connected } = ledgerClaims(
      [{ ledger_account: '1930', bank_connection_id: 'conn-old', enabled: false }],
      'conn-new',
    )
    expect(allocateLedgers([{ uid: 'a', currency: 'SEK' }], used, {}, connected)).toEqual({ a: '1930' })
  })

  it('rows of this connection are not claims at all', () => {
    const { used, connected } = ledgerClaims(
      [{ ledger_account: '1930', bank_connection_id: 'conn-new', enabled: true }],
      'conn-new',
    )
    expect(used).toEqual([])
    expect(connected).toEqual([])
  })

  it('the Ändra list offers 1930 back when only a manual row holds it', () => {
    const { used, connected } = ledgerClaims(cashAccounts, 'conn-new')
    const opts = ledgerOptions('SEK', used, '1931', connected)
    expect(opts).toContain('1930')
    expect(opts).not.toContain('1910')
    expect(ledgerOptions('SEK', used, '1931')).not.toContain('1930')
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
