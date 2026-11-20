import { describe, expect, it } from 'vitest'
import { formatNoteKr, parentOn, registerNoteTexts, securityNoteTexts, type GroupLinkNoteRow, type SecurityNoteRow } from '../note-text'

const BALANCE = '2026-12-31'
const kr = (n: number) => formatNoteKr(n)
const row = (r: Partial<SecurityNoteRow> & Pick<SecurityNoteRow, 'kind' | 'amount'>): SecurityNoteRow => ({
  for_group_company: false,
  valid_from: null,
  valid_to: null,
  ...r,
})

describe('securityNoteTexts', () => {
  it('says nothing when nothing is registered, so the note keeps its Inga.', () => {
    expect(securityNoteTexts([], BALANCE)).toEqual({ securities_pledged: null, contingent_liabilities: null })
  })

  it('states each K2 type of ställd säkerhet with its total, and the sum when there are several', () => {
    const texts = securityNoteTexts(
      [
        row({ kind: 'foretagsinteckning', amount: 500000 }),
        row({ kind: 'foretagsinteckning', amount: '250000.00' }),
        row({ kind: 'fastighetsinteckning', amount: 1200000 }),
        row({ kind: 'aganderattsforbehall', amount: 85000.4 }),
      ],
      BALANCE,
    )
    expect(texts.securities_pledged).toBe(
      `Företagsinteckningar ${kr(750000)} kr. Fastighetsinteckningar ${kr(1200000)} kr. Tillgångar med äganderättsförbehåll ${kr(85000)} kr. Summa ställda säkerheter ${kr(2035000.4)} kr.`,
    )
    expect(texts.contingent_liabilities).toBeNull()
  })

  it('always states borgen, and what was given for group companies apart', () => {
    const texts = securityNoteTexts(
      [row({ kind: 'borgen', amount: 300000, for_group_company: true }), row({ kind: 'other_contingency', amount: 50000 })],
      BALANCE,
    )
    expect(texts.contingent_liabilities).toBe(
      `Borgensförbindelser ${kr(300000)} kr. Övriga eventualförpliktelser ${kr(50000)} kr. Summa eventualförpliktelser ${kr(350000)} kr. Varav till förmån för koncernföretag ${kr(300000)} kr.`,
    )
    expect(texts.securities_pledged).toBeNull()
  })

  it('counts only what holds on the balance date', () => {
    const texts = securityNoteTexts(
      [
        row({ kind: 'belanad_fordran', amount: 10000, valid_to: '2026-06-30' }),
        row({ kind: 'other_security', amount: 20000, valid_from: '2027-01-01' }),
        row({ kind: 'other_security', amount: 30000, valid_from: '2026-01-01', valid_to: BALANCE }),
      ],
      BALANCE,
    )
    expect(texts.securities_pledged).toBe(`Andra ställda säkerheter ${kr(30000)} kr.`)
  })

  it('prints whole kronor with Swedish digit grouping', () => {
    expect(formatNoteKr(1234567.6).replace(/\s/g, ' ')).toBe('1 234 568')
  })
})

describe('parentOn', () => {
  const link = (r: Partial<GroupLinkNoteRow>): GroupLinkNoteRow => ({
    relation: 'parent',
    counterparty_name: 'Ägarbolaget AB',
    counterparty_org_number: '559000-0000',
    counterparty_registered_office: 'Stockholm',
    ownership_percent: 100,
    valid_from: null,
    valid_to: null,
    ...r,
  })

  it('answers the parent that holds on the balance date, with org number and säte', () => {
    expect(parentOn([link({})], BALANCE)).toEqual({ name: 'Ägarbolaget AB', org_number: '559000-0000', city: 'Stockholm' })
  })

  it('ignores subsidiaries, ended parents and parents not yet in place', () => {
    expect(
      parentOn(
        [link({ relation: 'subsidiary' }), link({ valid_to: '2026-06-30' }), link({ valid_from: '2027-01-01' })],
        BALANCE,
      ),
    ).toBeNull()
  })

  it('takes the larger holding when two parents hold', () => {
    const parent = parentOn([link({ counterparty_name: 'Liten AB', ownership_percent: 40 }), link({ counterparty_name: 'Stor AB', ownership_percent: '60.0000' })], BALANCE)
    expect(parent?.name).toBe('Stor AB')
  })

  it('leaves blank details out', () => {
    expect(parentOn([link({ counterparty_org_number: ' ', counterparty_registered_office: null })], BALANCE)).toEqual({ name: 'Ägarbolaget AB', org_number: null, city: null })
  })
})

describe('registerNoteTexts', () => {
  it('combines the security texts and the parent', () => {
    const texts = registerNoteTexts([row({ kind: 'borgen', amount: 1000 })], [], BALANCE)
    expect(texts).toEqual({ securities_pledged: null, contingent_liabilities: `Borgensförbindelser ${kr(1000)} kr.`, parent_company: null })
  })
})
