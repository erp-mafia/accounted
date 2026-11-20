import { describe, expect, it } from 'vitest'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import { FORM_SEEDED_ACCOUNTS } from '@/lib/bookkeeping/form-accounts'
import { BALANSRAKNING_LAYOUT, RESULTATRAKNING_LAYOUT, type K1Post } from '../bilaga2'
import {
  K1_ACCOUNT_RANGES,
  K1_EXCLUDED_RANGES,
  k1ExclusionForAccount,
  k1PostForAccount,
} from '../account-mapping'

const within = (n: string, r: { start: string; end: string }) => n >= r.start && n <= r.end

describe('förenklat årsbokslut: BAS to bilaga 2', () => {
  it('puts every BAS 2026 account in classes 1-8 in exactly one post or one excluded range', () => {
    const accounts = [...BAS_REFERENCE.map((a) => a.account_number), ...Object.keys(FORM_SEEDED_ACCOUNTS)]
    const problems: string[] = []
    for (const number of accounts) {
      if (number < '1000' || number > '8999') continue
      const posts = K1_ACCOUNT_RANGES.filter((r) => within(number, r)).length
      const excluded = K1_EXCLUDED_RANGES.filter((r) => within(number, r)).length
      if (posts + excluded !== 1) problems.push(`${number}: ${posts} post ranges, ${excluded} excluded ranges`)
    }
    expect(problems).toEqual([])
  })

  it('covers every four-digit number from 1000 to 8999 exactly once, so a custom account is never lost', () => {
    const problems: string[] = []
    for (let i = 1000; i <= 8999; i++) {
      const number = String(i)
      const hits =
        K1_ACCOUNT_RANGES.filter((r) => within(number, r)).length +
        K1_EXCLUDED_RANGES.filter((r) => within(number, r)).length
      if (hits !== 1) problems.push(`${number}: ${hits}`)
    }
    expect(problems).toEqual([])
  })

  it('reaches every post of the layout, except årets över-/underskott, which the engine reads off the closing account', () => {
    const targets = new Set<K1Post>(K1_ACCOUNT_RANGES.flatMap((r) => [r.credit, r.debit]))
    const posts = [...RESULTATRAKNING_LAYOUT, ...BALANSRAKNING_LAYOUT].flatMap((row) =>
      row.kind === 'post' ? [row.key] : [],
    )
    expect(posts.filter((post) => !targets.has(post))).toEqual(['aretsOverUnderskott'])
  })

  it('maps the förening accounts the issue names', () => {
    expect(k1PostForAccount('3901', -100)).toBe('medlemsavgifter')
    for (const bidrag of ['3980', '3981', '3985', '3987', '3988', '3989', '3993']) {
      expect(k1PostForAccount(bidrag, -100), bidrag).toBe('gavorOchBidrag')
    }
    expect(k1PostForAccount('3902', -100)).toBe('ovrigaVerksamhetsintakter')
    expect(k1PostForAccount('3004', -100)).toBe('forsaljningsintakter')
    expect(k1PostForAccount('3994', -100)).toBe('ovrigaIntakter')
    expect(k1PostForAccount('6710', 100)).toBe('verksamhetskostnader')
    expect(k1PostForAccount('4010', 100)).toBe('forsaljningskostnader')
    expect(k1PostForAccount('5010', 100)).toBe('ovrigaExternaKostnader')
    expect(k1PostForAccount('7510', 100)).toBe('personalkostnader')
    expect(k1PostForAccount('7832', 100)).toBe('avOchNedskrivningar')
    expect(k1PostForAccount('7970', 100)).toBe('ovrigaKostnader')
    for (const equity of ['2060', '2067', '2068', '2070', '2071', '2072']) {
      expect(k1PostForAccount(equity, -100), equity).toBe('balanseradeOverUnderskott')
    }
    expect(k1PostForAccount('2972', -100)).toBe('ovrigaSkulder')
    expect(k1PostForAccount('2611', -100)).toBe('skatteskulder')
    expect(k1PostForAccount('2731', -100)).toBe('skatteskulder')
    expect(k1PostForAccount('2440', -100)).toBe('leverantorsskulder')
    expect(k1PostForAccount('2420', -100)).toBe('ovrigaSkulder')
    expect(k1PostForAccount('2350', -100)).toBe('laneskulder')
    expect(k1PostForAccount('1480', 100)).toBe('ovrigaFordringar')
    expect(k1PostForAccount('1790', 100)).toBe('ovrigaFordringar')
    expect(k1PostForAccount('1930', 100)).toBe('kassaOchBank')
  })

  it('sends a financial account to income or cost by its own sign, never netting accounts', () => {
    expect(k1PostForAccount('8310', -100)).toBe('finansiellaIntakter')
    expect(k1PostForAccount('8410', 100)).toBe('finansiellaKostnader')
    expect(k1PostForAccount('8220', -100)).toBe('finansiellaIntakter')
    expect(k1PostForAccount('8220', 100)).toBe('finansiellaKostnader')
  })

  it('excludes avsättningar, other forms\' equity and the result accounts', () => {
    expect(k1ExclusionForAccount('2210')).toBe('avsattning')
    expect(k1ExclusionForAccount('2290')).toBe('avsattning')
    expect(k1ExclusionForAccount('2010')).toBe('other_form_equity')
    expect(k1ExclusionForAccount('2081')).toBe('other_form_equity')
    expect(k1ExclusionForAccount('2099')).toBe('other_form_equity')
    expect(k1ExclusionForAccount('8999')).toBe('result_account')
    expect(k1ExclusionForAccount('2067')).toBeNull()
    expect(k1PostForAccount('2210', -100)).toBeNull()
  })

  it('ignores what is not a four-digit account', () => {
    expect(k1PostForAccount('193', 100)).toBeNull()
    expect(k1PostForAccount('19300', 100)).toBeNull()
    expect(k1ExclusionForAccount('abcd')).toBeNull()
  })
})

describe('förenklat årsbokslut: the bilaga 2 layout', () => {
  it('lists the resultaträkning in BFN\'s order', () => {
    expect(RESULTATRAKNING_LAYOUT.map((row) => row.label)).toEqual([
      'Intäkter',
      'Medlemsavgifter',
      'Gåvor och bidrag',
      'Övriga verksamhetsintäkter',
      'Försäljningsintäkter',
      'Övriga intäkter',
      'Summa intäkter',
      'Kostnader',
      'Verksamhetskostnader',
      'Försäljningskostnader',
      'Övriga externa kostnader',
      'Personalkostnader',
      'Av- och nedskrivningar av materiella och immateriella anläggningstillgångar',
      'Övriga kostnader',
      'Summa kostnader',
      'Verksamhetens över-/underskott',
      'Finansiella intäkter',
      'Finansiella kostnader',
      'Över-/underskott efter finansiella poster',
      'Bokslutsdispositioner',
      'Skatt',
      'Årets över-/underskott',
    ])
  })

  it('lists the balansräkning in BFN\'s order', () => {
    expect(BALANSRAKNING_LAYOUT.map((row) => row.label)).toEqual([
      'Tillgångar',
      'Immateriella anläggningstillgångar',
      'Byggnader och mark',
      'Inventarier',
      'Varulager',
      'Kundfordringar',
      'Övriga fordringar',
      'Finansiella placeringar',
      'Kassa och bank',
      'Summa tillgångar',
      'Eget kapital',
      'Balanserade över-/underskott',
      'Årets över-/underskott',
      'Summa eget kapital',
      'Obeskattade reserver',
      'Skulder',
      'Låneskulder',
      'Leverantörsskulder',
      'Skatteskulder',
      'Övriga skulder',
      'Summa skulder',
      'Summa eget kapital och skulder',
    ])
  })

  it('marks the rubriker, which BFN does not allow to be renamed', () => {
    const rubriker = [...RESULTATRAKNING_LAYOUT, ...BALANSRAKNING_LAYOUT]
      .filter((row) => row.kind === 'rubrik')
      .map((row) => row.label)
    expect(rubriker).toEqual(['Intäkter', 'Kostnader', 'Tillgångar', 'Eget kapital', 'Skulder'])
  })
})
