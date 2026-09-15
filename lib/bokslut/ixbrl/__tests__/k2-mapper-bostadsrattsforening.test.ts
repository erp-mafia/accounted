import { describe, expect, it } from 'vitest'
import { mapTrialBalancesToK2, type TrialBalanceRowLike } from '../k2-mapper'
import { buildBrRows } from '@/lib/bokslut/arsredovisning/statement-rows'
import { buildK3EquityChangesStatement } from '@/lib/bokslut/arsredovisning/build-data'

const row = (account: string, name: string, debit: number, credit: number): TrialBalanceRowLike => ({
  account_number: account,
  account_name: name,
  closing_debit: debit,
  closing_credit: credit,
})

// A small bostadsrättsförening after closing: the building against insatser,
// upplåtelseavgifter, the fond för yttre underhåll, balanserat and årets
// resultat, with a bank balance and the inre reparationsfond as a liability.
const FULL = [
  row('1110', 'Byggnader', 10_000_000, 0),
  row('1119', 'Ack. avskrivningar byggnader', 0, 1_000_000),
  row('1930', 'Företagskonto', 700_000, 0),
  row('2083', 'Insatser', 0, 8_000_000),
  row('2087', 'Upplåtelseavgifter', 0, 900_000),
  row('2088', 'Fond för yttre underhåll', 0, 400_000),
  row('2091', 'Balanserat resultat', 0, 250_000),
  row('2099', 'Årets resultat', 0, 100_000),
  row('2892', 'Inre reparationsfond', 0, 50_000),
]
const PRE_CLOSING = [
  ...FULL.filter((r) => r.account_number !== '2099'),
  row('3020', 'Årsavgifter bostäder', 0, 100_000),
]

describe('mapTrialBalancesToK2: bostadsrättsförening equity (ÅRL 3 kap. 10 b §, K3 38.11)', () => {
  const brf = mapTrialBalancesToK2({ full: FULL, preClosing: PRE_CLOSING }, null, {
    legalForm: 'bostadsrattsforening',
  })

  it('presents insatser, upplåtelseavgifter and the yttre fond as their own bundet posts', () => {
    expect(brf.legalForm).toBe('bostadsrattsforening')
    expect(brf.br['Medlemsinsatser']).toEqual({ current: 8_000_000, previous: null })
    expect(brf.br['Upplatelseavgifter']).toEqual({ current: 900_000, previous: null })
    expect(brf.br['FondYttreUnderhall']).toEqual({ current: 400_000, previous: null })
    expect(brf.br['OverkursfondBunden']).toBeUndefined()
    // EFL allows a reservfond (2086) in any ekonomisk förening; it stays mapped and is simply zero here.
    expect(brf.br['Reservfond']).toEqual({ current: 0, previous: null })
    expect(brf.totals.bundetEgetKapital.current).toBe(9_300_000)
    expect(brf.totals.frittEgetKapital.current).toBe(350_000)
    expect(brf.totals.egetKapital.current).toBe(9_650_000)
    expect(brf.totals.tillgangar.current).toBe(brf.totals.egetKapitalSkulder.current)
    expect(brf.warnings).toEqual([])
  })

  it('renders the balance sheet rows with the BRF labels and no share capital', () => {
    const rows = buildBrRows(brf).equityLiabilities
    const labels = rows.map((r) => r.label)
    expect(labels).toEqual(
      expect.arrayContaining(['Insatser', 'Upplåtelseavgifter', 'Fond för yttre underhåll', 'Balanserat resultat']),
    )
    expect(labels).not.toContain('Aktiekapital')
    expect(labels).not.toContain('Överkursfond')
    expect(labels).not.toContain('Medlemsinsatser')
    const bundet = rows
      .filter((r) => ['Insatser', 'Upplåtelseavgifter', 'Förlagsinsatser', 'Fond för yttre underhåll', 'Uppskrivningsfond', 'Reservfond'].includes(r.label))
      .reduce((acc, r) => acc + (r.current ?? 0), 0)
    expect(bundet).toBe(rows.find((r) => r.label === 'Summa bundet eget kapital')?.current)
  })

  it('differs from the ekonomisk förening table: 2087 is upplåtelseavgifter, not insatsemission, and 2088 is not reservfond', () => {
    const ekf = mapTrialBalancesToK2({ full: FULL, preClosing: PRE_CLOSING }, null, { legalForm: 'ekonomisk_forening' })
    expect(ekf.br['Medlemsinsatser']?.current).toBe(8_900_000)
    expect(ekf.br['Reservfond']?.current).toBe(400_000)
    expect(ekf.br['Upplatelseavgifter']).toBeUndefined()
  })

  it('warns when share capital shows up in a bostadsrättsförening', () => {
    const withShareCapital = mapTrialBalancesToK2(
      { full: [...FULL, row('2081', 'Aktiekapital', 0, 25_000), row('1930', 'Bank', 25_000, 0)], preClosing: PRE_CLOSING },
      null,
      { legalForm: 'bostadsrattsforening' },
    )
    expect(withShareCapital.warnings.some((w) => w.includes('Aktiekapital (2081)') && w.includes('bostadsrättsförening'))).toBe(true)
  })

  it('absorbs an öre-rounding residual into the BRF equity posts', () => {
    const rows = [
      row('1930', 'Företagskonto', 100.98, 0),
      row('2083', 'Insatser', 0, 50.49),
      row('2087', 'Upplåtelseavgifter', 0, 50.49),
    ]
    const res = mapTrialBalancesToK2({ full: rows, preClosing: rows }, null, { legalForm: 'bostadsrattsforening' })
    expect(res.totals.tillgangar.current).toBe(101)
    expect(res.totals.egetKapitalSkulder.current).toBe(101)
    expect(res.warnings).toEqual([])
  })

  it('rolls the K3 equity statement forward over insatser and upplåtelseavgifter with BRF labels', () => {
    const statement = buildK3EquityChangesStatement(brf)
    const labels = statement.rows.map((r) => r.label)
    expect(labels).toContain('Ingående insatser, upplåtelseavgifter och förlagsinsatser')
    expect(statement.closing_total).toBe(9_650_000)
  })
})
