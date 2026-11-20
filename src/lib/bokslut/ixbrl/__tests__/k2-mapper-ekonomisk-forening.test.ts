import { describe, expect, it } from 'vitest'
import { mapTrialBalancesToK2, type TrialBalanceRowLike } from '../k2-mapper'
import { buildBrRows } from '@/lib/bokslut/arsredovisning/statement-rows'

const row = (account: string, name: string, debit: number, credit: number): TrialBalanceRowLike => ({
  account_number: account,
  account_name: name,
  closing_debit: debit,
  closing_credit: credit,
})

// A small kooperativ after closing: 300 000 kr bank against 200 000 kr
// medlemsinsatser, 50 000 kr förlagsinsatser, 20 000 kr reservfond,
// 10 000 kr balanserat and 20 000 kr årets resultat.
const FULL = [
  row('1930', 'Företagskonto', 300_000, 0),
  row('2083', 'Medlemsinsatser', 0, 200_000),
  row('2084', 'Förlagsinsatser', 0, 50_000),
  row('2086', 'Reservfond', 0, 20_000),
  row('2091', 'Balanserat resultat', 0, 10_000),
  row('2099', 'Årets resultat', 0, 20_000),
]
const PRE_CLOSING = [
  row('1930', 'Företagskonto', 300_000, 0),
  row('2083', 'Medlemsinsatser', 0, 200_000),
  row('2084', 'Förlagsinsatser', 0, 50_000),
  row('2086', 'Reservfond', 0, 20_000),
  row('2091', 'Balanserat resultat', 0, 10_000),
  row('3001', 'Försäljning', 0, 20_000),
]

describe('mapTrialBalancesToK2: ekonomisk förening equity (ÅRL 3 kap. 10 b §)', () => {
  const forening = mapTrialBalancesToK2({ full: FULL, preClosing: PRE_CLOSING }, null, {
    legalForm: 'ekonomisk_forening',
  })
  const ab = mapTrialBalancesToK2({ full: FULL, preClosing: PRE_CLOSING }, null)

  it('presents medlemsinsatser and förlagsinsatser as their own bundet posts', () => {
    expect(forening.legalForm).toBe('ekonomisk_forening')
    expect(forening.br['Medlemsinsatser']).toEqual({ current: 200_000, previous: null })
    expect(forening.br['Forlagsinsatser']).toEqual({ current: 50_000, previous: null })
    expect(forening.br['Reservfond']).toEqual({ current: 20_000, previous: null })
    expect(forening.totals.bundetEgetKapital.current).toBe(270_000)
    expect(forening.totals.frittEgetKapital.current).toBe(30_000)
    expect(forening.totals.egetKapital.current).toBe(300_000)
  })

  it('does not warn about the insatser, unlike the aktiebolag table', () => {
    expect(forening.warnings.some((w) => w.includes('Medlemsinsatser (2083)'))).toBe(false)
    expect(ab.warnings.some((w) => w.includes('Medlemsinsatser (2083)'))).toBe(true)
    expect(ab.br['Reservfond']?.current).toBe(270_000)
    expect(ab.legalForm).toBe('aktiebolag')
  })

  it('renders the balance sheet equity rows for the form', () => {
    const labels = buildBrRows(forening).equityLiabilities.map((r) => r.label)
    expect(labels).toEqual(expect.arrayContaining(['Medlemsinsatser', 'Förlagsinsatser', 'Reservfond']))
    expect(labels).not.toContain('Aktiekapital')
    expect(labels).not.toContain('Överkursfond')
    const abLabels = buildBrRows(ab).equityLiabilities.map((r) => r.label)
    expect(abLabels).toContain('Aktiekapital')
    expect(abLabels).not.toContain('Medlemsinsatser')
  })

  it('treats 2087 (insatsemission) as medlemsinsatser and keeps the rows summing to the bundet total', () => {
    const withEmission = mapTrialBalancesToK2(
      {
        full: [...FULL, row('2087', 'Insatsemission', 0, 30_000), row('1930', 'Bank', 30_000, 0)],
        preClosing: PRE_CLOSING,
      },
      null,
      { legalForm: 'ekonomisk_forening' },
    )
    expect(withEmission.br['Medlemsinsatser']?.current).toBe(230_000)
    expect(withEmission.br['OverkursfondBunden']).toBeUndefined()
    expect(withEmission.totals.bundetEgetKapital.current).toBe(300_000)
    const rows = buildBrRows(withEmission).equityLiabilities
    const bundetPosts = rows.filter((r) =>
      ['Medlemsinsatser', 'Förlagsinsatser', 'Uppskrivningsfond', 'Reservfond'].includes(r.label),
    )
    const sum = bundetPosts.reduce((acc, r) => acc + (r.current ?? 0), 0)
    expect(sum).toBe(rows.find((r) => r.label === 'Summa bundet eget kapital')?.current)
    expect(withEmission.warnings.some((w) => w.includes('2087'))).toBe(false)
  })

  it('warns when share capital shows up in an association', () => {
    const withShareCapital = mapTrialBalancesToK2(
      { full: [...FULL, row('2081', 'Aktiekapital', 0, 25_000), row('1930', 'Bank', 25_000, 0)], preClosing: PRE_CLOSING },
      null,
      { legalForm: 'ekonomisk_forening' },
    )
    expect(withShareCapital.warnings.some((w) => w.includes('Aktiekapital (2081)'))).toBe(true)
  })

  it('absorbs an öre-rounding residual into medlemsinsatser or förlagsinsatser (the form has no aktiebolag posts to smooth)', () => {
    // Two insatser posts of 50,49 each round to 50 + 50 = 100 while the bank
    // balance (100,98) rounds to 101. The +1 residual must land on one of the
    // förening's own fractional equity posts; the aktiebolag candidate set
    // holds neither concept and would leave a false balance error.
    const rows = [
      row('1930', 'Företagskonto', 100.98, 0),
      row('2083', 'Medlemsinsatser', 0, 50.49),
      row('2084', 'Förlagsinsatser', 0, 50.49),
    ]
    const res = mapTrialBalancesToK2({ full: rows, preClosing: rows }, null, { legalForm: 'ekonomisk_forening' })
    expect(res.totals.tillgangar.current).toBe(101)
    expect(res.totals.egetKapitalSkulder.current).toBe(101)
    expect((res.br['Medlemsinsatser']?.current ?? 0) + (res.br['Forlagsinsatser']?.current ?? 0)).toBe(101)
    expect(res.warnings).toEqual([])
  })
})

// crm#1080: an ekonomisk förening closes to 2099 and carries to 2098 like an
// aktiebolag (lib/company/forms/se-ekonomisk-forening.ts), and its fritt eget
// kapital has the same two posts, so the comparison year is derived the same
// way with the förening's own equity table.
describe('mapTrialBalancesToK2: ekonomisk förening comparison year never closed (crm#1080)', () => {
  const current = { full: FULL, preClosing: PRE_CLOSING }

  it('derives Årets resultat and keeps the insatser posts', () => {
    const res = mapTrialBalancesToK2(
      current,
      { full: PRE_CLOSING, preClosing: PRE_CLOSING },
      { legalForm: 'ekonomisk_forening' },
    )
    expect(res.br['AretsResultatEgetKapital']).toEqual({ current: 20_000, previous: 20_000 })
    expect(res.br['BalanseratResultat']).toEqual({ current: 10_000, previous: 10_000 })
    expect(res.br['Medlemsinsatser']).toEqual({ current: 200_000, previous: 200_000 })
    expect(res.totals.tillgangar.previous).toBe(300_000)
    expect(res.totals.egetKapitalSkulder.previous).toBe(300_000)
    expect(res.warnings).toEqual([
      'Jämförelseåret avslutades aldrig i bokföringen: årets resultat (20000 kr) står kvar på resultatkontona. Årets resultat i jämförelseårets balansräkning är därför hämtat från resultaträkningen. Stäm av jämförelsetalen mot föregående års fastställda årsredovisning.',
    ])
  })

  it('presents an earlier result left on 2099 as Balanserat resultat', () => {
    const rows = [
      ...PRE_CLOSING.filter((r) => r.account_number !== '2091'),
      { ...row('2099', 'Årets resultat', 0, 10_000), period_debit: 0, period_credit: 0 },
    ]
    const res = mapTrialBalancesToK2(current, { full: rows, preClosing: rows }, {
      legalForm: 'ekonomisk_forening',
    })
    expect(res.br['AretsResultatEgetKapital'].previous).toBe(20_000)
    expect(res.br['BalanseratResultat'].previous).toBe(10_000)
    expect(res.totals.tillgangar.previous).toBe(300_000)
    expect(res.totals.egetKapitalSkulder.previous).toBe(300_000)
    expect(res.warnings).toHaveLength(1)
    expect(res.warnings[0]).toContain(
      'Saldot på konto 2099 (10000 kr) fanns redan vid jämförelseårets ingång och visas som Balanserat resultat.',
    )
  })
})
