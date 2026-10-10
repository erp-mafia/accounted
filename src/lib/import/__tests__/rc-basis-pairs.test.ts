import { describe, expect, it } from 'vitest'
import { isReverseChargeBasisAccount } from '@/lib/bookkeeping/vat-entries'
import { rcBasisPairFinding, rcBasisPairsByAccount } from '../rc-basis-pairs'
import { parseSIEFile } from '../sie-parser'
import type { RcBasisPairEvidence } from '../types'

type Lines = Array<[account: string, amount: number]>

/** The vouchers of a SIE4 file holding one #VER per entry. */
function vouchers(...entries: Array<[date: string, lines: Lines]>) {
  const body = entries.map(([date, lines], i) => [
    `#VER A ${i + 1} ${date} "Inköp"`,
    '{',
    ...lines.map(([account, amount]) => `#TRANS ${account} {} ${amount}`),
    '}',
  ].join('\n'))
  return parseSIEFile(['#SIETYP 4', '#RAR 0 20260101 20261231', ...body].join('\n')).vouchers
}

/**
 * A reverse-charge purchase of `base` on `cost`, paid from the bank, with its
 * fiktiv moms at 25 %, and the basis on `pair` (basis leg, offset) when given.
 */
function purchase(cost: string, base: number, pair?: [string, string]): Lines {
  const vat = Math.round(base * 0.25 * 100) / 100
  const lines: Lines = [['1930', -base], [cost, base], ['2645', vat], ['2614', -vat]]
  return pair ? [...lines, [pair[0], base], [pair[1], -base]] : lines
}

const mirrored = (lines: Lines): Lines => lines.map(([account, amount]) => [account, -amount])

/**
 * Every account's finding with the legs judged as an unconfigured chart
 * reports them, the BAS basis accounts by number, plus `alsoReporting`: legs
 * whose momskod reports ruta 20-24.
 */
function findings(evidence: Map<string, RcBasisPairEvidence>, alsoReporting: string[] = []) {
  const legReports = (account: string) => isReverseChargeBasisAccount(account) || alsoReporting.includes(account)
  return new Map([...evidence]
    .map(([account, pairs]) => [account, rcBasisPairFinding(pairs, legReports)] as const)
    .filter(([, finding]) => finding !== null))
}

describe('rcBasisPairsByAccount (crm#1096)', () => {
  it('finds the cost account a voucher books beside a BAS basis pair, and nothing else', () => {
    const evidence = rcBasisPairsByAccount(vouchers(['20260129', purchase('5420', 120.5, ['4535', '4599'])]))
    const at = new Date(2026, 0, 29).getTime()
    expect([...evidence]).toEqual([['5420', {
      pairs: [{ legs: ['4535'], offsets: ['4599'], vouchers: 1, lastAt: at, lastSelfAssessedAt: at }],
    }]])
    expect([...findings(evidence)]).toEqual([['5420', { accounts: ['4535', '4599'], vouchers: 1, latest: true }]])
  })

  it('takes a 44xx/45xx leg the chart numbered itself for a pair only where that leg reports ruta 20-24', () => {
    const evidence = rcBasisPairsByAccount(vouchers(['20260810', purchase('5460', 1000, ['4505', '4599'])]))
    // 4505 is the leg here and 5460 the cost, but nothing reads 4505 by number.
    expect(evidence.get('5460')?.pairs).toMatchObject([{ legs: ['4505'], offsets: ['4599'], vouchers: 1 }])
    expect(findings(evidence).size).toBe(0)
    // With a reverse-charge momskod on 4505 the pair carries the basis.
    expect(findings(evidence, ['4505']).get('5460')).toEqual({ accounts: ['4505', '4599'], vouchers: 1, latest: true })
  })

  it('is no evidence where the leg reports elsewhere or nowhere: an import basis, a group account', () => {
    const evidence = rcBasisPairsByAccount(vouchers(
      // An import: tullvärde on 4545 (ruta 50) with its offset, moms on 2615.
      ['20260915', [['1930', -1000], ['4051', 1000], ['4545', 1000], ['4599', -1000], ['2645', 250], ['2615', -250]]],
      // An EU service whose pair leg is the group account 4500, which no box reads.
      ['20260916', [['1930', -1000], ['6540', 1000], ['4500', 1000], ['4598', -1000], ['2645', 250], ['2614', -250]]],
    ))
    expect(findings(evidence).size).toBe(0)
  })

  it('counts only the pairs whose every leg reports, and dates the file by those', () => {
    const evidence = rcBasisPairsByAccount(vouchers(
      ['20260110', purchase('4051', 500, ['4515', '4598'])],
      // The account's own basis from February on.
      ['20260215', purchase('4051', 800)],
      // A later import beside it is not a reverse-charge pair.
      ['20260915', [['1930', -1000], ['4051', 1000], ['4545', 1000], ['4599', -1000], ['2645', 250], ['2615', -250]]],
      // Nor is a pair only part of whose basis is on a leg that reports.
      ['20260920', [['1930', -900], ['4051', 900], ['4515', 600], ['4500', 300], ['4598', -900]]],
    ))
    expect(findings(evidence).get('4051')).toEqual({ accounts: ['4515', '4598'], vouchers: 1, latest: false })
  })

  it('takes a self-assessed purchase beside a pair that reports nothing for the account carrying its own basis', () => {
    const groupLeg: Lines = [['1930', -1000], ['6540', 1000], ['4500', 1000], ['4598', -1000], ['2645', 250], ['2614', -250]]
    const evidence = rcBasisPairsByAccount(vouchers(
      // A BAS pair first, then the source moves the basis leg to the group account.
      ['20260115', purchase('6540', 400, ['4535', '4598'])],
      ['20260610', groupLeg],
      // 5460: the later voucher is an import, which is no reverse-charge purchase at all.
      ['20260116', purchase('5460', 400, ['4515', '4598'])],
      ['20260915', [['1930', -1000], ['5460', 1000], ['4545', 1000], ['4599', -1000], ['2645', 250], ['2615', -250]]],
    ))
    // From June on only a momskod on 6540 reports the basis: it stays, with the warning.
    expect(findings(evidence).get('6540')).toEqual({ accounts: ['4535', '4598'], vouchers: 1, latest: false })
    expect(findings(evidence).get('5460')).toEqual({ accounts: ['4515', '4598'], vouchers: 1, latest: true })
  })

  it('leaves a voucher alone that books only the legs, self-numbered ones included', () => {
    const evidence = rcBasisPairsByAccount(vouchers(['20260930', [
      ['4505', 300], ['4531', 200], ['4535', 100.25], ['4599', -600.25],
    ]]))
    expect(evidence.size).toBe(0)
  })

  it('is no evidence where a leg cannot be told from the cost, or the legs do not balance the offset', () => {
    const evidence = rcBasisPairsByAccount(vouchers(
      // Two 45xx debits, each the size of the offset: which one is the leg?
      ['20260301', [['1930', -500], ['4500', 500], ['4545', 500], ['4598', -500]]],
      // The basis leg is not the offset's amount.
      ['20260302', [['1930', -300], ['5420', 200], ['4535', 200], ['4599', -100]]],
    ))
    expect(evidence.size).toBe(0)
  })

  it('counts a credit note like the purchase it reverses', () => {
    const evidence = rcBasisPairsByAccount(vouchers(
      ['20260129', purchase('5420', 120.5, ['4535', '4599'])],
      ['20260130', mirrored(purchase('5420', 120.5, ['4535', '4599']))],
    ))
    expect(findings(evidence).get('5420')).toEqual({ accounts: ['4535', '4599'], vouchers: 2, latest: true })
  })

  it('says whether the file ends on the pair or on the account carrying its own basis', () => {
    const evidence = rcBasisPairsByAccount(vouchers(
      // 5420: its own basis first, then a pair beside it that the file ends on.
      ['20260117', purchase('5420', 40)],
      ['20260129', purchase('5420', 120.5, ['4535', '4599'])],
      ['20260422', purchase('5420', 80)],
      ['20260922', purchase('5420', 200, ['4531', '4599'])],
      // 6540: a pair once, then its own basis from then on.
      ['20260228', purchase('6540', 1000, ['4535', '4599'])],
      ['20260331', purchase('6540', 1000)],
      ['20260731', purchase('6540', 1200)],
    ))
    expect(findings(evidence).get('5420')).toEqual({ accounts: ['4531', '4535', '4599'], vouchers: 2, latest: true })
    expect(findings(evidence).get('6540')).toEqual({ accounts: ['4535', '4599'], vouchers: 1, latest: false })
  })

  it('does not take a line beside a purchase booked straight on a BAS basis account for an own basis', () => {
    const evidence = rcBasisPairsByAccount(vouchers(
      ['20260129', purchase('5420', 120.5, ['4535', '4599'])],
      // Later: a purchase on 4535 itself, with a fee on 5420 in the same voucher.
      ['20260301', [['1930', -110], ['4535', 100], ['5420', 10], ['2645', 25], ['2614', -25]]],
    ))
    expect(findings(evidence).get('5420')).toEqual({ accounts: ['4535', '4599'], vouchers: 1, latest: true })
  })

  it('takes no account outside classes 4-6, nor one on the offset side, for a cost', () => {
    const evidence = rcBasisPairsByAccount(vouchers(['20260105', [
      ['2440', -4000], ['6550', 4000], ['4531', 4000], ['4599', -4000], ['2645', 1000], ['2614', -1000],
      // A reclassification on the offset's side is not a purchase beside the pair.
      ['4010', -100], ['1930', 100],
    ]]))
    expect([...evidence.keys()]).toEqual(['6550'])
  })
})
