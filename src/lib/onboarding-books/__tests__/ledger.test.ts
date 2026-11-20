import { describe, expect, it } from 'vitest'
import { overflowLedgerSlots } from '@/lib/cash-accounts/ledger-slots'
import { allocateLedgers, ledgerClaims, ledgerName, ledgerOptions } from '../ledger'

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
    expect(out.a).toBe('1935')
    expect(overflowLedgerSlots(['1930', '1931'])[0]).toBe('1935')
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
    ).toEqual({ a: '1930', b: '1935' })
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

describe('a manual row of another bank account keeps the account off the currency default (crm#129)', () => {
  // The server refuses to promote a holder with another IBAN or currency
  // (CASH_ACCOUNT_KEEPER_IDENTITY_CONFLICT). PATCH /accounts sends the
  // preview as an explicit mapping, so offering 1930 here failed the save.
  const OWN = 'SE4550000000058398257466'
  const OTHER = 'SE9912000000000000000001'
  const rows = (iban: string | null, currency = 'SEK') => [
    { ledger_account: '1930', bank_connection_id: null, enabled: true, iban, currency },
  ]

  it('skips 1930 when its manual row carries another IBAN', () => {
    const { used, connected, holders } = ledgerClaims(rows(OTHER), 'conn-new')
    expect(connected).toEqual([])
    expect(allocateLedgers([{ uid: 'a', currency: 'SEK', iban: OWN }], used, {}, connected, [], holders)).toEqual({ a: '1931' })
  })

  it('refuses a pick of 1930 there too', () => {
    const { used, connected, holders } = ledgerClaims(rows(OTHER), 'conn-new')
    expect(allocateLedgers([{ uid: 'a', currency: 'SEK', iban: OWN }], used, { a: '1930' }, connected, [], holders)).toEqual({ a: '1931' })
  })

  it('keeps 1930 when its manual row is the same account or has no IBAN', () => {
    for (const iban of ['se45 5000 0000 0583 9825 7466', null]) {
      const { used, connected, holders } = ledgerClaims(rows(iban), 'conn-new')
      expect(allocateLedgers([{ uid: 'a', currency: 'SEK', iban: OWN }], used, {}, connected, [], holders)).toEqual({ a: '1930' })
    }
  })

  it('skips a manual row in another currency', () => {
    const { used, connected, holders } = ledgerClaims(rows(null, 'EUR'), 'conn-new')
    expect(allocateLedgers([{ uid: 'a', currency: 'SEK', iban: OWN }], used, {}, connected, [], holders)).toEqual({ a: '1931' })
  })

  it('a disabled row of another connection is checked the same way', () => {
    // The save releases it to a manual row first, then promotes it.
    const { used, connected, holders } = ledgerClaims(
      [{ ledger_account: '1930', bank_connection_id: 'conn-old', enabled: false, iban: OTHER, currency: 'SEK' }],
      'conn-new',
    )
    expect(allocateLedgers([{ uid: 'a', currency: 'SEK', iban: OWN }], used, {}, connected, [], holders)).toEqual({ a: '1931' })
  })

  it('a row left on a revoked connection has no claim, as on the server', () => {
    // findFreeLedgerAccount and promote_psd2_cash_account read the connection
    // status, not the row's enabled flag: the same account gets its slot back.
    const revoked = (iban: string) => [
      { ledger_account: '1930', bank_connection_id: 'conn-old', enabled: true, iban, currency: 'SEK', bank_connection: { status: 'revoked' } },
    ]
    const same = ledgerClaims(revoked(OWN), 'conn-new')
    expect(same.connected).toEqual([])
    expect(allocateLedgers([{ uid: 'a', currency: 'SEK', iban: OWN }], same.used, {}, same.connected, [], same.holders)).toEqual({ a: '1930' })
    const other = ledgerClaims(revoked(OTHER), 'conn-new')
    expect(allocateLedgers([{ uid: 'a', currency: 'SEK', iban: OWN }], other.used, {}, other.connected, [], other.holders)).toEqual({ a: '1931' })
  })

  it('an enabled row of an active connection keeps its claim even for the same account', () => {
    const { used, connected, holders } = ledgerClaims(
      [{ ledger_account: '1930', bank_connection_id: 'conn-old', enabled: true, iban: OWN, currency: 'SEK', bank_connection: { status: 'active' } }],
      'conn-new',
    )
    expect(connected).toEqual(['1930'])
    expect(allocateLedgers([{ uid: 'a', currency: 'SEK', iban: OWN }], used, {}, connected, [], holders)).toEqual({ a: '1931' })
  })

  it('the Ändra list leaves 1930 out only for another account', () => {
    const other = ledgerClaims(rows(OTHER), 'conn-new')
    expect(ledgerOptions('SEK', other.used, '1931', other.connected, [], other.holders, OWN)).not.toContain('1930')
    const same = ledgerClaims(rows(OWN), 'conn-new')
    expect(ledgerOptions('SEK', same.used, '1931', same.connected, [], same.holders, OWN)).toContain('1930')
  })
})

describe('the preview follows the server rule for overflow slots', () => {
  // A SEK account ticked in onboarding with 1930 and 1931 taken went to 1932
  // and its new chart row was named "Bankkonto EUR".
  it('never gives a SEK account another currency default', () => {
    const out = allocateLedgers(
      [{ uid: 'a', currency: 'SEK' }, { uid: 'b', currency: 'SEK' }, { uid: 'c', currency: 'SEK' }],
      [],
      { a: '1930' },
      [],
    )
    expect(out).toEqual({ a: '1930', b: '1931', c: '1935' })
  })

  it('keeps an EUR account on 1932 behind two SEK overflows', () => {
    const out = allocateLedgers(
      [{ uid: 'a', currency: 'SEK' }, { uid: 'b', currency: 'SEK' }, { uid: 'c', currency: 'SEK' }, { uid: 'd', currency: 'EUR' }],
      [],
      {},
      [],
    )
    expect(out).toEqual({ a: '1930', b: '1931', c: '1935', d: '1932' })
  })

  it('an account without a preset never takes a later account preset', () => {
    // The callback already mirrored a on 1930 and b on 1931; d was ticked in
    // onboarding and sits between them in the bank's order.
    const out = allocateLedgers(
      [{ uid: 'a', currency: 'SEK' }, { uid: 'd', currency: 'SEK' }, { uid: 'b', currency: 'SEK' }],
      [],
      { a: '1930', b: '1931' },
      [],
    )
    expect(out).toEqual({ a: '1930', d: '1935', b: '1931' })
  })

  it('prefers a slot the chart does not name yet', () => {
    const out = allocateLedgers([{ uid: 'a', currency: 'SEK' }, { uid: 'b', currency: 'SEK' }], [], {}, [], ['1930', '1931', '1935'])
    expect(out).toEqual({ a: '1930', b: '1936' })
  })

  it('names a new slot after the account currency, not the number', () => {
    expect(ledgerName('1932', 'SEK')).toBe('Bankkonto SEK')
    expect(ledgerName('1932', 'EUR')).toBe('Bankkonto EUR')
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
