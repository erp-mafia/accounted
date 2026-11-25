import { describe, expect, it } from 'vitest'
import {
  buildFinancialFixedAssetsNote,
  buildTangibleImpairmentNote,
  grossMovementsByPost,
  hasBothWriteDownMovements,
  tangibleImpairmentBalance,
  withoutInternalMovements,
  writeDownsOutsideRegisterByPost,
  type WriteDownVoucher,
} from '../ledger-fixed-asset-notes'

/** The PDF groups thousands with a no-break space; compare with plain ones. */
const plain = (text: string | undefined) => text?.replace(/\u00a0/g, ' ')

function row(account_number: string, account_name: string, opening: number, debit: number, credit: number) {
  const closing = opening + debit - credit
  return {
    account_number,
    account_name,
    opening_debit: opening > 0 ? opening : 0,
    opening_credit: opening < 0 ? -opening : 0,
    period_debit: debit,
    period_credit: credit,
    closing_debit: closing > 0 ? closing : 0,
    closing_credit: closing < 0 ? -closing : 0,
  }
}

describe('buildFinancialFixedAssetsNote', () => {
  it('rolls each balance sheet post forward, with its impairments', () => {
    const note = buildFinancialFixedAssetsNote(
      [
        row('1310', 'Andelar i koncernföretag', 100000, 50000, 0),
        row('1318', 'Ackumulerade nedskrivningar av andelar i koncernföretag', -20000, 0, 10000),
        row('1350', 'Andelar och värdepapper i andra företag', 5000, 0, 5000),
        row('1930', 'Företagskonto', 1, 1, 1),
      ],
      4,
    )
    expect(note?.number).toBe(4)
    expect(note?.title).toBe('Finansiella anläggningstillgångar')
    expect(plain(note?.body)).toContain('Andelar i koncernföretag\n  Ingående anskaffningsvärde: 100 000 kr')
    expect(plain(note?.body)).toContain('  Tillkommande: 50 000 kr')
    expect(plain(note?.body)).toContain('  Utgående anskaffningsvärde: 150 000 kr')
    expect(plain(note?.body)).toContain('  Årets nedskrivningar: \u221210 000 kr')
    expect(plain(note?.body)).toContain('  Utgående nedskrivningar: \u221230 000 kr')
    expect(plain(note?.body)).toContain('  Utgående redovisat värde: 120 000 kr')
    expect(plain(note?.body)).toContain('Andra långfristiga värdepappersinnehav\n  Ingående anskaffningsvärde: 5 000 kr')
    expect(plain(note?.body)).not.toContain('Företagskonto')
  })

  it('is absent without financial fixed assets, and leaves the deferred tax asset to its own note', () => {
    expect(buildFinancialFixedAssetsNote([row('1930', 'Företagskonto', 1000, 0, 0)], 3)).toBeNull()
    expect(buildFinancialFixedAssetsNote([row('1370', 'Uppskjuten skattefordran', 4000, 0, 0)], 3)).toBeNull()
  })
})

describe('impairments of intangible and tangible fixed assets', () => {
  const rows = [
    row('1220', 'Inventarier och verktyg', 80000, 0, 0),
    row('1229', 'Ackumulerade avskrivningar på inventarier och verktyg', -20000, 0, 16000),
    row('1228', 'Ackumulerade nedskrivningar på inventarier och verktyg', 0, 0, 5000),
  ]

  it('reads the accumulated impairments, which the asset register does not carry', () => {
    expect(tangibleImpairmentBalance(rows)).toBe(-5000)
  })

  it('discloses the year\'s impairments per account', () => {
    const note = buildTangibleImpairmentNote(rows, 5)
    expect(note?.title).toBe('Nedskrivningar av anläggningstillgångar')
    expect(plain(note?.body)).toContain('Ackumulerade nedskrivningar på inventarier och verktyg')
    expect(plain(note?.body)).toContain('  Årets nedskrivningar: \u22125 000 kr')
    expect(plain(note?.body)).not.toContain('avskrivningar på inventarier')
  })

  it('is absent without impairments', () => {
    expect(buildTangibleImpairmentNote(rows.slice(0, 2), 5)).toBeNull()
  })

  // One source per nedskrivning: what the register booked on 1228 is in the
  // register roll-forward, so only the rest is disclosed here.
  it('discloses only what the register did not book, and nothing when it booked it all', () => {
    const booked = (writtenDown: number) =>
      new Map([['1228', { opening: 0, writtenDown, reversed: 0, disposed: 0, closing: writtenDown }]])
    expect(buildTangibleImpairmentNote(rows, 5, booked(5000))).toBeNull()
    expect(tangibleImpairmentBalance(rows, booked(5000))).toBe(0)

    const note = buildTangibleImpairmentNote(rows, 5, booked(3000))
    expect(plain(note?.body)).toContain('utanför anläggningsregistret')
    expect(plain(note?.body)).toContain('  Årets nedskrivningar: \u22122 000 kr')
    expect(tangibleImpairmentBalance(rows, booked(3000))).toBe(-2000)
  })

  it('leaves out an account where the register holds more than the ledger, for the tie-out to report', () => {
    const more = new Map([['1228', { opening: 0, writtenDown: 8000, reversed: 0, disposed: 0, closing: 8000 }]])
    expect(buildTangibleImpairmentNote(rows, 5, more)).toBeNull()
    expect(tangibleImpairmentBalance(rows, more)).toBe(0)
  })
})

// K2: the table of a post shows every nedskrivning of the post, so what the
// ledger holds beyond the register is summed per post, not judged per account.
describe('writeDownsOutsideRegisterByPost', () => {
  const postOf = (account: string) => (account >= '1100' && account < '1200' ? 'ByggnaderMark' : account >= '1200' && account < '1300' ? 'Inventarier' : null)
  const registered = new Map([['1118', { opening: 100_000, writtenDown: 50_000, reversed: 20_000, disposed: 0, closing: 130_000 }]])

  it('sums what each post\'s write-down accounts hold beyond the register', () => {
    const byPost = writeDownsOutsideRegisterByPost(
      [
        row('1118', 'Ackumulerade nedskrivningar på byggnader', -100_000, 20_000, 61_000),
        row('1158', 'Ackumulerade nedskrivningar på markanläggningar', -4_000, 0, 5_000),
        row('1228', 'Ackumulerade nedskrivningar på inventarier', 0, 0, 7_000),
        row('1110', 'Byggnader', 1_000_000, 0, 0),
      ],
      registered,
      postOf,
    )
    expect(byPost.get('ByggnaderMark')).toEqual({ opening: 4_000, written: 16_000, released: 0, closing: 20_000, accounts: ['1118', '1158'] })
    expect(byPost.get('Inventarier')).toEqual({ opening: 0, written: 7_000, released: 0, closing: 7_000, accounts: ['1228'] })
  })

  it('is empty for a post the register explains in full', () => {
    const byPost = writeDownsOutsideRegisterByPost(
      [row('1118', 'Ackumulerade nedskrivningar på byggnader', -100_000, 20_000, 50_000)],
      registered,
      postOf,
    )
    expect(byPost.size).toBe(0)
  })

  it('nets a movement between two accounts of one post, which no single account explains', () => {
    // The register holds 20 000 on 1158; 6 000 of it was moved out by hand,
    // and 1118 holds 40 000 from before, 10 000 of it reversed by hand.
    const byPost = writeDownsOutsideRegisterByPost(
      [
        row('1118', 'Ackumulerade nedskrivningar på byggnader', -40_000, 10_000, 0),
        row('1158', 'Ackumulerade nedskrivningar på markanläggningar', -20_000, 6_000, 0),
      ],
      new Map([['1158', { opening: 20_000, writtenDown: 0, reversed: 0, disposed: 0, closing: 20_000 }]]),
      postOf,
    )
    // 1158 alone would not add up (the register holds more than the ledger).
    expect(byPost.get('ByggnaderMark')).toMatchObject({ opening: 40_000, written: 0, released: 16_000, closing: 24_000 })
  })

  it('leaves out a post whose sum does not add up as a write-down, for the ledger note and the tie-out', () => {
    const byPost = writeDownsOutsideRegisterByPost(
      [row('1118', 'Ackumulerade nedskrivningar på byggnader', -100_000, 20_000, 30_000)],
      registered,
      postOf,
    )
    expect(byPost.size).toBe(0)
  })

  it('keeps the accounts of a post whose remainders cancel, so the ledger note does not show the nedskrivning again', () => {
    // The register holds 50 000 on 1118; the ledger holds it on 1158.
    const rows = [
      row('1118', 'Ackumulerade nedskrivningar på byggnader', 0, 0, 0),
      row('1158', 'Ackumulerade nedskrivningar på markanläggningar', -50_000, 0, 0),
    ]
    const onOtherAccount = new Map([['1118', { opening: 50_000, writtenDown: 0, reversed: 0, disposed: 0, closing: 50_000 }]])
    const byPost = writeDownsOutsideRegisterByPost(rows, onOtherAccount, postOf)
    expect(byPost.get('ByggnaderMark')).toEqual({ opening: 0, written: 0, released: 0, closing: 0, accounts: ['1118', '1158'] })
    // The post's table shows the register's 50 000; without its accounts the
    // ledger note is empty.
    const inTable = new Set(byPost.get('ByggnaderMark')?.accounts)
    expect(buildTangibleImpairmentNote(rows.filter((r) => !inTable.has(r.account_number)), 3, onOtherAccount)).toBeNull()
  })

  it('takes the register\'s write-down off the post also when the trial balance no longer lists its account', () => {
    // 130 000 written down through the register on 1118 and moved by hand to
    // 1158; 1118 has nothing left and is not in the trial balance.
    const rows = [row('1158', 'Ackumulerade nedskrivningar på markanläggningar', -130_000, 0, 0)]
    const moved = new Map([['1118', { opening: 130_000, writtenDown: 0, reversed: 0, disposed: 0, closing: 130_000 }]])
    const byPost = writeDownsOutsideRegisterByPost(rows, moved, postOf)
    expect(byPost.get('ByggnaderMark')).toEqual({ opening: 0, written: 0, released: 0, closing: 0, accounts: ['1158', '1118'] })
  })

  it('reads an account that is in the trial balance by its name only: one the company named itself may hold avskrivningar too', () => {
    // 1238 holds the accumulated avskrivningar of an asset (60 000) and the
    // 30 000 the register wrote down on it. It is no write-down account by
    // name, so nothing on it is read as a nedskrivning beyond the register.
    const rows = [row('1238', 'Ackumulerade avskrivningar, lånade inventarier', -90_000, 0, 30_000)]
    const own = new Map([['1238', { opening: 0, writtenDown: 30_000, reversed: 0, disposed: 0, closing: 30_000 }]])
    expect(writeDownsOutsideRegisterByPost(rows, own, postOf).size).toBe(0)
  })

  it('tells when a post was both credited and debited beyond the register', () => {
    expect(hasBothWriteDownMovements({ written: 10_000, released: 10_000 })).toBe(true)
    expect(hasBothWriteDownMovements({ written: 10_000, released: 0 })).toBe(false)
    expect(hasBothWriteDownMovements({ written: 0, released: 10_000 })).toBe(false)
  })
})

describe('grossMovementsByPost', () => {
  const postOf = (account: string) => (account >= '1100' && account < '1200' ? 'ByggnaderMark' : account >= '1200' && account < '1300' ? 'Inventarier' : null)
  const none = { accumulated: new Set<string>(), writeDown: new Set<string>() }

  it('splits the year\'s movement of a post in anskaffningsvärden and accumulated avskrivningar, and leaves the write-down accounts out', () => {
    const rows = [
      row('1110', 'Byggnader', 1_000_000, 80_000, 30_000),
      row('1119', 'Ackumulerade avskrivningar på byggnader', -200_000, 5_000, 45_000),
      row('1118', 'Ackumulerade nedskrivningar på byggnader', -50_000, 0, 10_000),
      row('1930', 'Företagskonto', 100_000, 500, 0),
      row('2099', 'Årets resultat', 0, 0, 1),
    ]
    expect(grossMovementsByPost(rows, postOf, none)).toEqual(new Map([['ByggnaderMark', { cost: 50_000, depreciation: 40_000 }]]))
  })

  it('knows an accumulated account by the register when its name does not say so, and a write-down account the register wrote down on', () => {
    const rows = [
      row('1220', 'Inventarier', 60_000, 8_000, 0),
      row('1225', 'Värdeminskning inventarier', -12_000, 0, 15_000),
      row('1226', 'Värdejustering inventarier', 0, 0, 4_000),
    ]
    const register = { accumulated: new Set(['1225']), writeDown: new Set(['1226']) }
    expect(grossMovementsByPost(rows, postOf, register).get('Inventarier')).toEqual({ cost: 8_000, depreciation: 15_000 })
    // Without the register both are read as anskaffningsvärden: the names say nothing.
    expect(grossMovementsByPost(rows, postOf, none).get('Inventarier')).toEqual({ cost: -11_000, depreciation: 0 })
  })

  it('cannot tell avskrivningar from nedskrivningar on an account that holds both', () => {
    const shared = [row('1220', 'Inventarier', 60_000, 0, 0), row('1228', 'Ackumulerade nedskrivningar på inventarier', -30_000, 0, 12_000)]
    expect(grossMovementsByPost(shared, postOf, { accumulated: new Set(['1228']), writeDown: new Set() }).get('Inventarier')).toEqual({
      cost: 0,
      depreciation: null,
    })
    const combined = [row('1229', 'Ackumulerade av- och nedskrivningar på inventarier', -30_000, 0, 12_000)]
    expect(grossMovementsByPost(combined, postOf, none).get('Inventarier')).toEqual({ cost: 0, depreciation: null })
  })
})

describe('withoutInternalMovements', () => {
  const outside = (written: number, released: number, accounts = ['1118', '1158']) =>
    new Map([['ByggnaderMark', { opening: 30_000, written, released, closing: 30_000 + written - released, accounts }]])
  const voucher = (id: string, lines: Array<[string, number, number]>, reverses_id: string | null = null): WriteDownVoucher => ({
    id,
    reverses_id,
    lines: lines.map(([account_number, debit, credit]) => ({ account_number, debit, credit })),
  })

  it('takes out a movement between two write-down accounts of the post: neither a nedskrivning nor an återföring', () => {
    const result = withoutInternalMovements(outside(10_000, 10_000), [voucher('v1', [['1118', 10_000, 0], ['1158', 0, 10_000]])])
    expect(result.get('ByggnaderMark')).toMatchObject({ opening: 30_000, written: 0, released: 0, closing: 30_000 })
  })

  it('takes out a verifikat and its storno, both in the year', () => {
    const result = withoutInternalMovements(outside(5_000, 5_000), [
      voucher('v1', [['7720', 5_000, 0], ['1118', 0, 5_000]]),
      voucher('v2', [['1118', 5_000, 0], ['7720', 0, 5_000]], 'v1'),
    ])
    expect(result.get('ByggnaderMark')).toMatchObject({ written: 0, released: 0 })
  })

  it('keeps a nedskrivning and an återföring that are their own verifikat, whatever their amounts', () => {
    // 10 000 written down in June and 10 000 of an older one reversed in December.
    const result = withoutInternalMovements(outside(10_000, 10_000), [
      voucher('v1', [['7720', 10_000, 0], ['1118', 0, 10_000]]),
      voucher('v2', [['1158', 10_000, 0], ['7780', 0, 10_000]]),
    ])
    expect(result.get('ByggnaderMark')).toMatchObject({ written: 10_000, released: 10_000 })
  })

  it('takes out the moved part of a verifikat only, and never more than the accounts moved beyond the register', () => {
    // One verifikat writes 8 000 down on 1158 and moves 2 000 there from 1118.
    const mixed = withoutInternalMovements(outside(10_000, 2_000), [
      voucher('v1', [['1118', 2_000, 0], ['1158', 0, 10_000], ['7720', 8_000, 0]]),
    ])
    expect(mixed.get('ByggnaderMark')).toMatchObject({ written: 8_000, released: 0 })
    // A register write-down reversed by storno is in neither side beyond the register.
    const capped = withoutInternalMovements(outside(0, 3_000), [
      voucher('v1', [['7720', 5_000, 0], ['1118', 0, 5_000]]),
      voucher('v2', [['1118', 5_000, 0], ['7720', 0, 5_000]], 'v1'),
    ])
    expect(capped.get('ByggnaderMark')).toMatchObject({ written: 0, released: 3_000 })
  })

  it('keeps a nedskrivning and an återföring booked in one verifikat, each against the result', () => {
    // 10 000 written down on 1118 and 6 000 of an older one on 1158 reversed,
    // in the same verifikat. Nothing moved between the two accounts.
    const result = withoutInternalMovements(outside(10_000, 6_000), [
      voucher('v1', [['7720', 10_000, 0], ['1118', 0, 10_000], ['1158', 6_000, 0], ['7780', 0, 6_000]]),
    ])
    expect(result.get('ByggnaderMark')).toMatchObject({ written: 10_000, released: 6_000 })
  })

  it('does not read a year\'s ingående balans as a movement', () => {
    // An opening verifikat that debits one write-down account and credits
    // another (a balance carried in on the wrong side) nets nothing out of
    // the year's own nedskrivning and återföring.
    const opening: WriteDownVoucher = { ...voucher('ib', [['1118', 7_000, 0], ['1158', 0, 7_000]]), source_type: 'opening_balance' }
    const result = withoutInternalMovements(outside(7_000, 7_000), [
      opening,
      voucher('v1', [['7720', 7_000, 0], ['1118', 0, 7_000]]),
      voucher('v2', [['1158', 7_000, 0], ['7780', 0, 7_000]]),
    ])
    expect(result.get('ByggnaderMark')).toMatchObject({ written: 7_000, released: 7_000 })
  })

  it('reads a storno whose original is not among the year\'s verifikat as it stands', () => {
    const result = withoutInternalMovements(outside(4_000, 5_000), [voucher('v2', [['1118', 5_000, 0], ['7720', 0, 5_000]], 'v-last-year')])
    expect(result.get('ByggnaderMark')).toMatchObject({ written: 4_000, released: 5_000 })
  })

  it('looks only at the post\'s own write-down accounts', () => {
    // A movement between write-down accounts of two posts is a decrease in
    // one and an increase in the other.
    const result = withoutInternalMovements(outside(0, 10_000, ['1118']), [voucher('v1', [['1118', 10_000, 0], ['1228', 0, 10_000]])])
    expect(result.get('ByggnaderMark')).toMatchObject({ written: 0, released: 10_000 })
  })
})
