import { describe, expect, it } from 'vitest'
import {
  buildFinancialFixedAssetsNote,
  buildTangibleImpairmentNote,
  tangibleImpairmentBalance,
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
    expect(plain(note?.body)).toContain('  Årets nedskrivningar: -10 000 kr')
    expect(plain(note?.body)).toContain('  Utgående nedskrivningar: -30 000 kr')
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
    expect(plain(note?.body)).toContain('  Årets nedskrivningar: -5 000 kr')
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
    expect(plain(note?.body)).toContain('  Årets nedskrivningar: -2 000 kr')
    expect(tangibleImpairmentBalance(rows, booked(3000))).toBe(-2000)
  })

  it('leaves out an account where the register holds more than the ledger, for the tie-out to report', () => {
    const more = new Map([['1228', { opening: 0, writtenDown: 8000, reversed: 0, disposed: 0, closing: 8000 }]])
    expect(buildTangibleImpairmentNote(rows, 5, more)).toBeNull()
    expect(tangibleImpairmentBalance(rows, more)).toBe(0)
  })
})
