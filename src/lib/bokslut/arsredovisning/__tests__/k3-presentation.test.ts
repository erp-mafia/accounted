import { describe, expect, it } from 'vitest'
import { mapTrialBalancesToK2, type TrialBalanceRowLike } from '@/lib/bokslut/ixbrl/k2-mapper'
import { buildBrRows } from '../statement-rows'
import { k3EquityPosts, toK3Presentation } from '../k3-presentation'
import { k2EquityPosts } from '../equity-specification'

function row(account: string, debitNet: number, name = `Konto ${account}`): TrialBalanceRowLike {
  return {
    account_number: account,
    account_name: name,
    closing_debit: debitNet > 0 ? debitNet : 0,
    closing_credit: debitNet < 0 ? -debitNet : 0,
    period_debit: 0,
    period_credit: 0,
  }
}

// A balanced year: assets 1010 dev costs, 1220 inventarier, 1370 deferred tax
// asset, 1640 tax receivable, 1930 bank; equity 2081, 2089, 2096, 2098, 2099;
// provisions 2240, 2250; payables 2440.
const FULL: TrialBalanceRowLike[] = [
  row('1010', 200_000),
  row('1019', -40_000),
  row('1220', 50_000),
  row('1370', 10_000),
  row('1640', 3_000),
  row('1930', 300_000),
  row('2081', -25_000),
  row('2089', -160_000),
  row('2096', -5_000),
  row('2098', -150_000),
  row('2099', -73_000),
  row('2240', -60_000),
  row('2250', -2_000),
  row('2440', -48_000),
]
const PRE_CLOSING: TrialBalanceRowLike[] = [row('3001', -200_000), row('5010', 127_000)]

function k2() {
  return mapTrialBalancesToK2({ full: FULL, preClosing: PRE_CLOSING }, null, { legalForm: 'aktiebolag' })
}

describe('toK3Presentation', () => {
  it('carves K3 posts out of the K2 posts and leaves every total unchanged', () => {
    const base = k2()
    const k3 = toK3Presentation(base, FULL, null)
    expect(k3.presentation).toBe('k3')
    expect(k3.totals).toEqual(base.totals)
    expect(k3.br['BalanseradeUtgifterUtvecklingsarbetenLiknandeArbeten'].current).toBe(160_000)
    expect(k3.br['KoncessionerPatentLicenserVarumarkenLiknandeRattigheter'].current).toBe(0)
    expect(k3.br['UppskjutenSkattefordran'].current).toBe(10_000)
    expect(k3.br['AndraLangfristigaFordringar'].current).toBe(0)
    expect(k3.br['AktuellSkattefodran'].current).toBe(3_000)
    expect(k3.br['FondUtvecklingsutgifter'].current).toBe(160_000)
    expect(k3.br['Reservfond'].current).toBe(0)
    expect(k3.br['FondVerkligtVarde'].current).toBe(5_000)
    expect(k3.br['BalanseratResultat'].current).toBe(150_000)
    expect(k3.br['UppskjutenSkatteskuld'].current).toBe(60_000)
    expect(k3.br['AvsattningarOvrigSkatt'].current).toBe(2_000)
    expect(k3.br['OvrigaAvsattningar'].current).toBe(0)
  })

  it('does not touch the K2 mapping it was given', () => {
    const base = k2()
    const before = JSON.stringify(base)
    toK3Presentation(base, FULL, null)
    expect(JSON.stringify(base)).toBe(before)
  })

  it('drops the K2 nudge to review 2089 under Reservfond', () => {
    const base = k2()
    expect(base.warnings.some((w) => w.startsWith('Fond för utvecklingsutgifter (2089)'))).toBe(true)
    expect(toK3Presentation(base, FULL, null).warnings.some((w) => w.startsWith('Fond för utvecklingsutgifter (2089)'))).toBe(false)
  })

  it('treats an overpaid 25xx as aktuell skattefordran', () => {
    const full = [...FULL.filter((r) => r.account_number !== '1640' && r.account_number !== '1930'), row('2518', 8_000), row('2512', -5_000), row('1930', 300_000)]
    // keep the year balanced: 1640 (3 000) out, 25xx net debit 3 000 in
    const k3 = toK3Presentation(mapTrialBalancesToK2({ full, preClosing: PRE_CLOSING }, null), full, null)
    expect(k3.br['AktuellSkattefodran'].current).toBe(3_000)
  })
})

describe('buildBrRows with K3 posts', () => {
  it('prints the K3 posts in a K3 report and nothing new in a K2 one', () => {
    const base = k2()
    const k2Rows = buildBrRows(base)
    const k3Rows = buildBrRows(toK3Presentation(base, FULL, null))
    const labels = (rows: { label: string }[]) => rows.map((r) => r.label)
    const k3Only = [
      'Balanserade utgifter för utvecklingsarbeten och liknande arbeten',
      'Uppskjuten skattefordran',
      'Aktuell skattefordran',
      'Fond för utvecklingsutgifter',
      'Fond för verkligt värde',
      'Uppskjuten skatteskuld',
      'Övriga avsättningar för skatter',
    ]
    for (const label of k3Only) {
      expect(labels([...k3Rows.assets, ...k3Rows.equityLiabilities])).toContain(label)
      expect(labels([...k2Rows.assets, ...k2Rows.equityLiabilities])).not.toContain(label)
    }
    const total = (rows: { label: string; current: number | null }[], label: string) => rows.find((r) => r.label === label)?.current
    expect(total(k3Rows.assets, 'Summa tillgångar')).toBe(total(k2Rows.assets, 'Summa tillgångar'))
    expect(total(k3Rows.equityLiabilities, 'Summa eget kapital')).toBe(total(k2Rows.equityLiabilities, 'Summa eget kapital'))
  })
})

describe('k3EquityPosts', () => {
  it('gives 2089 and 2096 their own posts and takes them out of Reservfond and Balanserat resultat', () => {
    const posts = k3EquityPosts('aktiebolag')
    expect(posts.map((p) => p.concept)).toEqual([
      'Aktiekapital',
      'EjRegistreratAktiekapital',
      'OverkursfondBunden',
      'Uppskrivningsfond',
      'Reservfond',
      'FondUtvecklingsutgifter',
      'Overkursfond',
      'FondVerkligtVarde',
      'BalanseratResultat',
      'AretsResultatEgetKapital',
    ])
    const ranges = (concept: string) => posts.find((p) => p.concept === concept)!.ranges
    expect(ranges('Reservfond')).toEqual([
      { start: '2083', end: '2084' },
      { start: '2086', end: '2086' },
      { start: '2088', end: '2088' },
    ])
    expect(ranges('BalanseratResultat')).toEqual([
      { start: '2090', end: '2095' },
      { start: '2098', end: '2098' },
    ])
    // K2 is untouched.
    expect(k2EquityPosts('aktiebolag').find((p) => p.concept === 'Reservfond')!.ranges).toContainEqual({ start: '2088', end: '2089' })
  })
})
