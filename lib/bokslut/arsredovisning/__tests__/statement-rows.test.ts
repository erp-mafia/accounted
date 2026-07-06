/**
 * ÅRL post-level statement rows for the årsredovisning PDF.
 *
 * The regression that matters most here: NO label may carry a BAS account
 * number. A user filed an årsredovisning whose RR/BR listed per-account rows
 * ("1930 Företagskonto", "3001 Försäljning …") and Bolagsverket rejected it
 * with "Balansräkning och resultaträkning ska inte innehålla kontonummer".
 * The rows must be the statutory posts from the K2 risbs mapping — the same
 * mapping the iXBRL filing uses — so PDF and digital filing cannot diverge.
 */
import { describe, it, expect } from 'vitest'
import {
  mapTrialBalancesToK2,
  type TrialBalanceRowLike,
  type TrialBalancePair,
} from '@/lib/bokslut/ixbrl/k2-mapper'
import { buildRrRows, buildBrRows } from '../statement-rows'

function tbRow(
  account: string,
  name: string,
  opts: { debit?: number; credit?: number },
): TrialBalanceRowLike {
  return {
    account_number: account,
    account_name: name,
    closing_debit: opts.debit ?? 0,
    closing_credit: opts.credit ?? 0,
  }
}

/**
 * Balanced fixture year: 600 000 bank = 50 000 aktiekapital + 250 000
 * balanserat + 300 000 årets resultat. RR: 520 600 omsättning − 200 000
 * kostnader − 20 600 skatt = 300 000.
 */
function currentPair(): TrialBalancePair {
  const full = [
    tbRow('1930', 'Företagskonto', { debit: 600_000 }),
    tbRow('2081', 'Aktiekapital', { credit: 50_000 }),
    tbRow('2091', 'Balanserad vinst', { credit: 250_000 }),
    tbRow('2099', 'Årets resultat', { credit: 300_000 }),
  ]
  const preClosing = [
    ...full.filter((r) => r.account_number !== '2099'),
    tbRow('3001', 'Försäljning varor 25%', { credit: 520_600 }),
    tbRow('4010', 'Inköp material', { debit: 200_000 }),
    tbRow('8910', 'Skatt på årets resultat', { debit: 20_600 }),
  ]
  return { full, preClosing }
}

function previousPair(): TrialBalancePair {
  const full = [
    tbRow('1930', 'Företagskonto', { debit: 300_000 }),
    tbRow('2081', 'Aktiekapital', { credit: 50_000 }),
    tbRow('2091', 'Balanserad vinst', { credit: 100_000 }),
    tbRow('2099', 'Årets resultat', { credit: 150_000 }),
  ]
  const preClosing = [
    ...full.filter((r) => r.account_number !== '2099'),
    tbRow('3001', 'Försäljning varor 25%', { credit: 250_000 }),
    tbRow('4010', 'Inköp material', { debit: 100_000 }),
  ]
  return { full, preClosing }
}

describe('buildRrRows / buildBrRows — no kontonummer regression', () => {
  it('no RR or BR label contains a BAS account number', () => {
    const mapping = mapTrialBalancesToK2(currentPair(), previousPair())
    const rr = buildRrRows(mapping)
    const { assets, equityLiabilities } = buildBrRows(mapping)
    for (const row of [...rr, ...assets, ...equityLiabilities]) {
      // Catches both "1930 Företagskonto" prefixes and any stray 4-digit
      // account reference inside a label.
      expect(row.label).not.toMatch(/\d{4}/)
    }
  })
})

describe('buildRrRows', () => {
  it('follows the ÅRL uppställningsform order with posts and subtotals', () => {
    const mapping = mapTrialBalancesToK2(currentPair(), null)
    const labels = buildRrRows(mapping).map((r) => r.label)
    const order = [
      'Rörelseintäkter, lagerförändringar m.m.',
      'Nettoomsättning',
      'Summa rörelseintäkter, lagerförändringar m.m.',
      'Rörelsekostnader',
      'Råvaror och förnödenheter',
      'Summa rörelsekostnader',
      'Rörelseresultat',
      'Summa finansiella poster',
      'Resultat efter finansiella poster',
      'Resultat före skatt',
      'Skatt på årets resultat',
      'Årets resultat',
    ]
    const indices = order.map((label) => labels.indexOf(label))
    expect(indices).not.toContain(-1)
    expect([...indices].sort((a, b) => a - b)).toEqual(indices)
  })

  it('shows cost posts with a presentational minus', () => {
    const mapping = mapTrialBalancesToK2(currentPair(), null)
    const rr = buildRrRows(mapping)
    expect(rr.find((r) => r.label === 'Råvaror och förnödenheter')?.current).toBe(-200_000)
    expect(rr.find((r) => r.label === 'Skatt på årets resultat')?.current).toBe(-20_600)
    expect(rr.find((r) => r.label === 'Summa rörelsekostnader')?.current).toBe(-200_000)
  })

  it('skips zero posts but keeps Nettoomsättning and all subtotals', () => {
    const mapping = mapTrialBalancesToK2(currentPair(), null)
    const labels = buildRrRows(mapping).map((r) => r.label)
    expect(labels).not.toContain('Handelsvaror')
    expect(labels).not.toContain('Övriga rörelseintäkter')
    expect(labels).toContain('Nettoomsättning')
    expect(labels).toContain('Summa finansiella poster')
  })

  it('omits the Bokslutsdispositioner section when no dispositions are booked', () => {
    const mapping = mapTrialBalancesToK2(currentPair(), null)
    const labels = buildRrRows(mapping).map((r) => r.label)
    expect(labels).not.toContain('Bokslutsdispositioner')
    expect(labels).not.toContain('Summa bokslutsdispositioner')
  })

  it('ties Årets resultat to the mapping total and the booked 2099', () => {
    const mapping = mapTrialBalancesToK2(currentPair(), null)
    const rr = buildRrRows(mapping)
    const aretsResultat = rr[rr.length - 1]
    expect(aretsResultat.label).toBe('Årets resultat')
    expect(aretsResultat.is_total).toBe(true)
    expect(aretsResultat.current).toBe(mapping.totals.aretsResultat.current)
    expect(aretsResultat.current).toBe(300_000)
  })

  it('fills the jämförelseår column when a previous year exists, null otherwise', () => {
    const withPrev = buildRrRows(mapTrialBalancesToK2(currentPair(), previousPair()))
    expect(withPrev.find((r) => r.label === 'Nettoomsättning')?.previous).toBe(250_000)
    expect(withPrev.find((r) => r.label === 'Årets resultat')?.previous).toBe(150_000)

    const firstYear = buildRrRows(mapTrialBalancesToK2(currentPair(), null))
    expect(firstYear.find((r) => r.label === 'Nettoomsättning')?.previous).toBeNull()
  })
})

describe('buildBrRows', () => {
  it('renders Kassa och bank as a post and ends both sides on tied totals', () => {
    const mapping = mapTrialBalancesToK2(currentPair(), null)
    const { assets, equityLiabilities } = buildBrRows(mapping)

    expect(assets.find((r) => r.label === 'Kassa och bank' && !r.is_heading)?.current).toBe(
      600_000,
    )
    const totalAssets = assets[assets.length - 1]
    expect(totalAssets.label).toBe('Summa tillgångar')
    expect(totalAssets.current).toBe(600_000)

    const totalEqLiab = equityLiabilities[equityLiabilities.length - 1]
    expect(totalEqLiab.label).toBe('Summa eget kapital och skulder')
    expect(totalEqLiab.current).toBe(600_000)
    expect(totalEqLiab.current).toBe(totalAssets.current)
  })

  it('omits zero subsections (varulager, obeskattade reserver, långfristiga skulder)', () => {
    const mapping = mapTrialBalancesToK2(currentPair(), null)
    const { assets, equityLiabilities } = buildBrRows(mapping)
    const labels = [...assets, ...equityLiabilities].map((r) => r.label)
    expect(labels).not.toContain('Varulager m.m.')
    expect(labels).not.toContain('Obeskattade reserver')
    expect(labels).not.toContain('Långfristiga skulder')
  })

  it('keeps statutory always-visible posts even at zero', () => {
    const mapping = mapTrialBalancesToK2(currentPair(), null)
    const { assets, equityLiabilities } = buildBrRows(mapping)
    expect(assets.some((r) => r.label === 'Övriga fordringar')).toBe(true)
    expect(equityLiabilities.some((r) => r.label === 'Leverantörsskulder')).toBe(true)
    expect(equityLiabilities.some((r) => r.label === 'Balanserat resultat')).toBe(true)
  })

  it('maps equity to Bundet/Fritt posts with previous-year figures', () => {
    const mapping = mapTrialBalancesToK2(currentPair(), previousPair())
    const { equityLiabilities } = buildBrRows(mapping)
    const aktiekapital = equityLiabilities.find((r) => r.label === 'Aktiekapital')
    expect(aktiekapital?.current).toBe(50_000)
    expect(aktiekapital?.previous).toBe(50_000)
    const balanserat = equityLiabilities.find((r) => r.label === 'Balanserat resultat')
    expect(balanserat?.current).toBe(250_000)
    expect(balanserat?.previous).toBe(100_000)
    const summaEk = equityLiabilities.find((r) => r.label === 'Summa eget kapital')
    expect(summaEk?.current).toBe(600_000)
    expect(summaEk?.previous).toBe(300_000)
  })

  it('produces no mapper warnings for the balanced fixture', () => {
    const mapping = mapTrialBalancesToK2(currentPair(), previousPair())
    expect(mapping.warnings).toEqual([])
  })
})
