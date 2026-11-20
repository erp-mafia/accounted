import { describe, expect, it } from 'vitest'
import {
  mapTrialBalancesToK2,
  type TrialBalancePair,
  type TrialBalanceRowLike,
} from '../k2-mapper'
import { CURRENT, PREVIOUS } from './fixtures'

const row = (
  account: string,
  name: string,
  debit: number,
  credit: number,
): TrialBalanceRowLike => ({
  account_number: account,
  account_name: name,
  closing_debit: debit,
  closing_credit: credit,
})

describe('mapTrialBalancesToK2', () => {
  // Realistic post-bokslut pairs: full TB has class 3-8 zeroed + 2099 booked;
  // preClosing TB has the RR accounts open (see fixtures.ts).
  const result = mapTrialBalancesToK2(CURRENT, PREVIOUS)

  it('maps RR posts with natural orientation for both years', () => {
    expect(result.rr['Nettoomsattning']).toEqual({ current: 1_000_000, previous: 500_000 })
    expect(result.rr['RavarorFornodenheterKostnader']).toEqual({
      current: 200_000,
      previous: 200_000,
    })
    expect(result.rr['OvrigaExternaKostnader']).toEqual({ current: 100_000, previous: 80_000 })
    expect(result.rr['Personalkostnader']).toEqual({ current: 525_660, previous: 150_000 })
    expect(
      result.rr['AvskrivningarNedskrivningarMateriellaImmateriellaAnlaggningstillgangar'],
    ).toEqual({ current: 20_000, previous: 8_000 })
    expect(result.rr['OvrigaRanteintakterLiknandeResultatposter']).toEqual({
      current: 1_000,
      previous: 0,
    })
    expect(result.rr['RantekostnaderLiknandeResultatposter']).toEqual({
      current: 4_000,
      previous: 2_000,
    })
    // 8811 avsättning = debit → credit-oriented concept goes negative.
    expect(result.rr['ForandringPeriodiseringsfond']).toEqual({ current: -10_000, previous: 0 })
    expect(result.rr['SkattAretsResultat']).toEqual({ current: 21_340, previous: 20_000 })
  })

  it('computes RR subtotals down to årets resultat', () => {
    expect(result.totals.rorelseintakter.current).toBe(1_000_000)
    expect(result.totals.rorelsekostnader.current).toBe(845_660)
    expect(result.totals.rorelseresultat.current).toBe(154_340)
    expect(result.totals.finansiellaPoster.current).toBe(-3_000)
    expect(result.totals.resultatEfterFinansiellaPoster.current).toBe(151_340)
    expect(result.totals.bokslutsdispositioner.current).toBe(-10_000)
    expect(result.totals.resultatForeSkatt.current).toBe(141_340)
    expect(result.totals.aretsResultat.current).toBe(120_000)
    expect(result.totals.aretsResultat.previous).toBe(40_000)
  })

  it('maps BR posts and nets contra accounts (ack. avskrivningar)', () => {
    expect(result.br['InventarierVerktygInstallationer']).toEqual({
      current: 60_000,
      previous: 68_000,
    })
    expect(result.br['Kundfordringar']).toEqual({ current: 50_000, previous: 0 })
    expect(result.br['KassaBankExklRedovisningsmedel']).toEqual({
      current: 270_000,
      previous: 185_000,
    })
    expect(result.br['Aktiekapital']).toEqual({ current: 25_000, previous: 25_000 })
    expect(result.br['BalanseratResultat']).toEqual({ current: 100_000, previous: 60_000 })
    expect(result.br['AretsResultatEgetKapital']).toEqual({ current: 120_000, previous: 40_000 })
    expect(result.br['Periodiseringsfonder']).toEqual({ current: 40_000, previous: 30_000 })
    expect(result.br['Leverantorsskulder']).toEqual({ current: 30_000, previous: 25_000 })
    expect(result.br['Skatteskulder']).toEqual({ current: 35_000, previous: 15_000 })
    // Moms (2610) lands in övriga kortfristiga skulder.
    expect(result.br['OvrigaKortfristigaSkulder']).toEqual({ current: 20_000, previous: 8_000 })
    expect(result.br['UpplupnaKostnaderForutbetaldaIntakter']).toEqual({
      current: 10_000,
      previous: 50_000,
    })
  })

  it('balances: Summa tillgångar == Summa eget kapital och skulder (3005)', () => {
    expect(result.totals.tillgangar.current).toBe(380_000)
    expect(result.totals.egetKapitalSkulder.current).toBe(380_000)
    expect(result.totals.tillgangar.previous).toBe(253_000)
    expect(result.totals.egetKapitalSkulder.previous).toBe(253_000)
    expect(result.warnings).toEqual([])
    expect(result.unmappedAccounts).toEqual([])
  })

  it('reconciles RR-result against BR 2099', () => {
    expect(result.totals.aretsResultat.current).toBe(result.br['AretsResultatEgetKapital'].current)
  })

  it('reclassifies tax and VAT balances by economic sign', () => {
    const rows = [
      row('1930', 'Bank', 100, 0),
      row('1630', 'Tax account', 0, 20),
      row('2518', 'Paid preliminary tax', 30, 0),
      row('2641', 'Input VAT', 5, 0),
      row('2081', 'Share capital', 0, 115),
    ]

    const res = mapTrialBalancesToK2({ full: rows, preClosing: rows }, null)

    expect(res.br['OvrigaFordringarKortfristiga'].current).toBe(35)
    expect(res.br['Skatteskulder'].current).toBe(20)
    expect(res.br['OvrigaKortfristigaSkulder'].current).toBe(0)
    expect(res.totals.tillgangar.current).toBe(135)
    expect(res.totals.egetKapitalSkulder.current).toBe(135)
    expect(res.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('1630-1659'),
        expect.stringContaining('2500-2599'),
        expect.stringContaining('2610-2659'),
      ]),
    )
  })

  it('maps account 7833 depreciation from the statutory pre-closing balance', () => {
    const full = [
      row('1250', 'Computers', 50, 0),
      row('1259', 'Accumulated depreciation', 0, 10),
      row('1930', 'Bank', 100, 0),
      row('2081', 'Share capital', 0, 50),
      row('2099', 'Current-year result', 0, 90),
    ]
    const preClosing = [
      ...full.filter((balance) => balance.account_number !== '2099'),
      row('3010', 'Revenue', 0, 100),
      row('7833', 'Depreciation of computers', 10, 0),
    ]

    const res = mapTrialBalancesToK2({ full, preClosing }, null)

    expect(
      res.rr['AvskrivningarNedskrivningarMateriellaImmateriellaAnlaggningstillgangar']
        .current,
    ).toBe(10)
    expect(res.totals.aretsResultat.current).toBe(90)
    expect(res.br['AretsResultatEgetKapital'].current).toBe(90)
    expect(res.totals.tillgangar.current).toBe(res.totals.egetKapitalSkulder.current)
  })

  it('presents a debit on account 2650 as a receivable for each comparison year', () => {
    const current = [
      row('1930', 'Bank', 75, 0),
      row('2081', 'Share capital', 0, 100),
      row('2650', 'VAT settlement account', 25, 0),
    ]
    const previous = [
      row('1930', 'Bank', 100, 0),
      row('2081', 'Share capital', 0, 75),
      row('2650', 'VAT settlement account', 0, 25),
    ]

    const res = mapTrialBalancesToK2(
      { full: current, preClosing: current },
      { full: previous, preClosing: previous },
    )

    expect(res.br['OvrigaFordringarKortfristiga']).toEqual({ current: 25, previous: 0 })
    expect(res.br['OvrigaKortfristigaSkulder']).toEqual({ current: 0, previous: 25 })
    expect(res.totals.tillgangar).toEqual({ current: 100, previous: 100 })
    expect(res.totals.egetKapitalSkulder).toEqual({ current: 100, previous: 100 })
  })

  it('nets paid preliminary tax against the current tax liability', () => {
    const rows = [
      row('1930', 'Bank', 100, 0),
      row('2512', 'Current tax', 0, 123.18),
      row('2518', 'Paid preliminary tax', 23.18, 0),
    ]

    const res = mapTrialBalancesToK2({ full: rows, preClosing: rows }, null)

    expect(res.br['Skatteskulder'].current).toBe(100)
    expect(res.br['OvrigaFordringarKortfristiga'].current).toBe(0)
  })

  it('nets domestic VAT without offsetting excise duty', () => {
    const rows = [
      row('1930', 'Bank', 15, 0),
      row('2611', 'Output VAT', 0, 50),
      row('2641', 'Input VAT', 75, 0),
      row('2660', 'Excise duty', 0, 40),
    ]

    const res = mapTrialBalancesToK2({ full: rows, preClosing: rows }, null)

    expect(res.br['OvrigaFordringarKortfristiga'].current).toBe(25)
    expect(res.br['OvrigaKortfristigaSkulder'].current).toBe(40)
    expect(res.totals.tillgangar.current).toBe(40)
    expect(res.totals.egetKapitalSkulder.current).toBe(40)
  })

  it('reclassifies a previous-year tax-account credit independently', () => {
    const current = [
      row('1930', 'Bank', 100, 0),
      row('2081', 'Share capital', 0, 100),
    ]
    const previous = [
      row('1930', 'Bank', 20, 0),
      row('1630', 'Tax account', 0, 20),
    ]

    const res = mapTrialBalancesToK2(
      { full: current, preClosing: current },
      { full: previous, preClosing: previous },
    )

    expect(res.br['OvrigaFordringarKortfristiga']).toEqual({ current: 0, previous: 0 })
    expect(res.br['Skatteskulder']).toEqual({ current: 0, previous: 20 })
    expect(res.warnings).toContainEqual(expect.stringContaining('1630-1659'))
  })

  it('does not offset a tax-account liability against a separate tax receivable', () => {
    const rows = [
      row('1630', 'Tax account', 0, 100),
      row('1650', 'VAT receivable', 100, 0),
      row('2081', 'Share capital', 0, 100),
      row('1930', 'Bank', 100, 0),
    ]

    const res = mapTrialBalancesToK2({ full: rows, preClosing: rows }, null)

    expect(res.br['OvrigaFordringarKortfristiga'].current).toBe(100)
    expect(res.br['Skatteskulder'].current).toBe(100)
    expect(res.totals.tillgangar.current).toBe(200)
    expect(res.totals.egetKapitalSkulder.current).toBe(200)
  })

  // Regression for the year-end-closing split: a realistic post-bokslut TB
  // pair must yield NON-ZERO RR concepts (from the pre-closing TB) AND a BR
  // that ties (from the full TB). Mapping a single TB can never do both: the
  // closing entry zeroes class 3-8, so RR concepts would collapse to 0.
  it('regression: post-bokslut pair gives non-zero RR and a balancing BR', () => {
    const res = mapTrialBalancesToK2(CURRENT, PREVIOUS)
    expect(res.rr['Nettoomsattning'].current).toBe(1_000_000)
    expect(res.totals.aretsResultat.current).toBe(120_000)
    expect(res.totals.aretsResultat.current).toBe(res.br['AretsResultatEgetKapital'].current)
    expect(res.totals.tillgangar.current).toBe(res.totals.egetKapitalSkulder.current)
    expect(res.warnings).toEqual([])

    // Sanity: the full TB really has the RR accounts zeroed: mapping it as
    // the RR source would produce an all-zero resultaträkning.
    const wrong = mapTrialBalancesToK2(
      { full: CURRENT.full, preClosing: CURRENT.full },
      null,
    )
    expect(wrong.rr['Nettoomsattning'].current).toBe(0)
  })

  it('handles first fiscal year (no previous trial balance)', () => {
    const firstYear = mapTrialBalancesToK2(CURRENT, null)
    expect(firstYear.rr['Nettoomsattning']).toEqual({ current: 1_000_000, previous: null })
    expect(firstYear.totals.tillgangar.previous).toBeNull()
  })

  it('flags unmapped accounts (their balance never reaches the BR)', () => {
    const broken = {
      full: CURRENT.full,
      preClosing: [...CURRENT.preClosing, row('9999', 'Internkonto', 5_000, 0)],
    }
    const res = mapTrialBalancesToK2(broken, null)
    expect(res.unmappedAccounts).toHaveLength(1)
    expect(res.unmappedAccounts[0].account).toBe('9999')
    expect(res.warnings.some((w) => w.includes('9999'))).toBe(true)
  })

  it('warns when the mapped balance sheet does not balance (3005)', () => {
    const brokenFull = CURRENT.full.map((r2) =>
      r2.account_number === '1930' ? { ...r2, closing_debit: 275_000 } : r2,
    )
    const res = mapTrialBalancesToK2({ full: brokenFull, preClosing: CURRENT.preClosing }, null)
    expect(res.warnings.some((w) => w.includes('3005'))).toBe(true)
  })

  it('warns when 2099 is not booked (RR ≠ BR result)', () => {
    // "Bokslut not run" = the full TB equals the pre-closing TB (no closing
    // entry exists), so 2099 carries no result.
    const res = mapTrialBalancesToK2(
      { full: CURRENT.preClosing, preClosing: CURRENT.preClosing },
      null,
    )
    expect(res.warnings.some((w) => w.includes('2099'))).toBe(true)
  })

  it('routes lagerförändringar per K2 split (4910 → råvaror, 4960 → handelsvaror, 4940 → förändring av lager)', () => {
    const rows = [
      row('3010', 'Försäljning', 0, 100_000),
      row('4910', 'Förändring lager råvaror', 0, 5_000),
      row('4940', 'Förändring produkter i arbete', 0, 7_000),
      row('4960', 'Förändring lager handelsvaror', 3_000, 0),
    ]
    const res = mapTrialBalancesToK2({ full: rows, preClosing: rows }, null)
    expect(res.rr['RavarorFornodenheterKostnader'].current).toBe(-5_000)
    expect(
      res.rr['ForandringLagerProdukterIArbeteFardigaVarorPagaendeArbetenAnnansRakning'].current,
    ).toBe(7_000)
    expect(res.rr['HandelsvarorKostnader'].current).toBe(3_000)
  })

  it('routes 77xx nedskrivningar per K2 split (7710-7733 → anläggningstillgångar, 7740/7790 → omsättningstillgångar)', () => {
    const rows = [
      row('7710', 'Nedskrivningar av immateriella anläggningstillgångar', 10_000, 0),
      row('7730', 'Nedskrivningar av maskiner respektive inventarier', 5_000, 0),
      row('7770', 'Återföring av nedskrivningar av byggnader och mark', 0, 2_000),
      row('7740', 'Nedskrivningar av vissa omsättningstillgångar', 4_000, 0),
      row('7790', 'Återföring av nedskrivningar av vissa omsättningstillgångar', 0, 1_000),
      row('7810', 'Avskrivningar på immateriella anläggningstillgångar', 20_000, 0),
    ]
    const res = mapTrialBalancesToK2({ full: rows, preClosing: rows }, null)
    // 10 000 + 5 000 - 2 000 återföring + 20 000 avskrivningar
    expect(
      res.rr['AvskrivningarNedskrivningarMateriellaImmateriellaAnlaggningstillgangar'].current,
    ).toBe(33_000)
    // 4 000 - 1 000 återföring
    expect(res.rr['NedskrivningarOmsattningstillgangarUtoverNormalaNedskrivningar'].current).toBe(
      3_000,
    )
  })
})

describe('mapTrialBalancesToK2: öre-rounding residual smoothing', () => {
  it('absorbs a ±1 kr BR residual into a post with an exact öre balance', () => {
    // Assets round UP twice (.50 each), liabilities round once up once down:
    // rounded Tillgångar 202 vs rounded EK+skulder 201 although the TB ties
    // exactly at 201,00. The +1 residual lands on a fractional post, never
    // on an unrelated exact whole-krona balance.
    const rows = [
      row('1510', 'Kundfordringar', 100.5, 0),
      row('1930', 'Bank', 100.5, 0),
      row('2440', 'Leverantörsskulder', 0, 100.75),
      row('2510', 'Skatteskulder', 0, 100.25),
    ]
    const res = mapTrialBalancesToK2({ full: rows, preClosing: rows }, null)
    expect(res.totals.tillgangar.current).toBe(201)
    expect(res.totals.egetKapitalSkulder.current).toBe(201)
    expect(res.br['Kundfordringar'].current).toBe(100)
    expect(res.br['Leverantorsskulder'].current).toBe(101)
    expect(res.br['Skatteskulder'].current).toBe(100)
    expect(res.warnings).toEqual([])
  })

  it('absorbs a ±1 kr RR residual so the RR result equals 2099 exactly', () => {
    // Two revenue posts of 100,25 each round to 100 + 100 = 200, while the
    // booked 2099 (200,50) rounds to 201. The −1 residual is absorbed by the
    // largest RR post (Nettoomsättning).
    const preClosing = [
      row('1930', 'Bank', 200.5, 0),
      row('3010', 'Försäljning', 0, 100.25),
      row('3990', 'Övriga intäkter', 0, 100.25),
    ]
    const full = [
      row('1930', 'Bank', 200.5, 0),
      row('2099', 'Årets resultat', 0, 200.5),
      row('3010', 'Försäljning', 100.25, 100.25),
      row('3990', 'Övriga intäkter', 100.25, 100.25),
    ]
    const res = mapTrialBalancesToK2({ full, preClosing }, null)
    expect(res.rr['Nettoomsattning'].current).toBe(101)
    expect(res.totals.aretsResultat.current).toBe(201)
    expect(res.br['AretsResultatEgetKapital'].current).toBe(201)
    expect(res.totals.tillgangar.current).toBe(res.totals.egetKapitalSkulder.current)
    expect(res.warnings).toEqual([])
  })

  it('distributes a multi-krona BR residual over fractional posts', () => {
    const rows = [
      row('1510', 'Trade receivable', 0.5, 0),
      row('1630', 'Tax account', 0.5, 0),
      row('1710', 'Prepaid expense', 0.5, 0),
      row('1810', 'Short-term investment', 0.5, 0),
      row('1930', 'Bank', 0.5, 0),
      row('2081', 'Share capital', 0, 2.5),
    ]

    const res = mapTrialBalancesToK2({ full: rows, preClosing: rows }, null)

    expect(res.totals.tillgangar.current).toBe(3)
    expect(res.totals.egetKapitalSkulder.current).toBe(3)
    expect(res.warnings.some((warning) => warning.includes('3005'))).toBe(false)
  })

  it('normalizes exact öre sums before whole-krona rounding', () => {
    const rows = [
      row('1510', 'Trade receivable', 0.03, 0),
      row('1710', 'Prepaid expense', 0.29, 0),
      row('1930', 'Bank', 0.18, 0),
      row('2081', 'Share capital', 0, 0.5),
    ]

    const res = mapTrialBalancesToK2({ full: rows, preClosing: rows }, null)

    expect(res.totals.tillgangar.current).toBe(1)
    expect(res.totals.egetKapitalSkulder.current).toBe(1)
    expect(res.warnings.some((warning) => warning.includes('3005'))).toBe(false)
  })

  it('distributes a multi-krona RR residual over fractional posts', () => {
    const incomeRows = [
      row('3010', 'Revenue', 0, 0.5),
      row('3810', 'Capitalized work', 0, 0.5),
      row('3910', 'Other income', 0, 0.5),
      row('8010', 'Group result', 0, 0.5),
      row('8310', 'Interest income', 0, 0.5),
    ]
    const preClosing = [row('1930', 'Bank', 2.5, 0), ...incomeRows]
    const full = [
      row('1930', 'Bank', 2.5, 0),
      row('2099', 'Current result', 0, 2.5),
      ...incomeRows.map((incomeRow) => ({
        ...incomeRow,
        closing_debit: incomeRow.closing_credit,
      })),
    ]

    const res = mapTrialBalancesToK2({ full, preClosing }, null)

    expect(res.totals.aretsResultat.current).toBe(3)
    expect(res.br['AretsResultatEgetKapital'].current).toBe(3)
    expect(res.warnings.some((warning) => warning.includes('2099'))).toBe(false)
  })

  it('leaves real bookkeeping differences alone and reports them', () => {
    const rows = [
      row('1930', 'Bank', 1_000, 0),
      row('2440', 'Leverantörsskulder', 0, 990),
    ]
    const res = mapTrialBalancesToK2({ full: rows, preClosing: rows }, null)
    expect(res.br['Leverantorsskulder'].current).toBe(990)
    expect(res.warnings.some((w) => w.includes('3005'))).toBe(true)
  })
})

describe('mapTrialBalancesToK2: årets resultat on 8999 (feedback seq 345150)', () => {
  it('does not report 8999 as missing from the ÅR: the result is derived from the RR sum', () => {
    // A year imported already closed by another system: the result sits on
    // 8999 in the pre-closing TB (the closing 2099 booking is in the full TB).
    const closedElsewhere = {
      full: CURRENT.full,
      preClosing: [...CURRENT.preClosing, row('8999', 'Årets resultat', 0, 120_000)],
    }
    const res = mapTrialBalancesToK2(closedElsewhere, null)
    expect(res.unmappedAccounts).toEqual([])
    expect(res.warnings.some((w) => w.includes('8999') && w.includes('saknas'))).toBe(false)
    const note = res.warnings.find((w) => w.startsWith('Konto 8999'))
    expect(note).toBe(
      'Konto 8999 (Årets resultat) ingår inte i K2-mappningen: årets resultat beräknas från resultaträkningens summa. Ingen åtgärd behövs.',
    )
    // RR totals are untouched: 8999 is outside every RR range.
    expect(res.totals.aretsResultat.current).toBe(120_000)
  })

  it('emits the note once per account across both years and still flags a real unmapped account', () => {
    const res = mapTrialBalancesToK2(
      {
        full: CURRENT.full,
        preClosing: [
          ...CURRENT.preClosing,
          row('8999', 'Årets resultat', 0, 120_000),
          row('9999', 'Internkonto', 5_000, 0),
        ],
      },
      {
        full: PREVIOUS.full,
        preClosing: [...PREVIOUS.preClosing, row('8999', 'Årets resultat', 0, 40_000)],
      },
    )
    expect(res.warnings.filter((w) => w.startsWith('Konto 8999'))).toHaveLength(1)
    expect(res.unmappedAccounts.map((u) => u.account)).toEqual(['9999'])
    expect(res.warnings.some((w) => w.includes('9999') && w.includes('täcks inte av K2-mappningen'))).toBe(true)
  })
})

// crm#1080. The comparison year in every shape the books can leave it in.
// The fixture year (PREVIOUS) made 40 000 kr: 253 000 kr assets against
// 25 000 aktiekapital, 60 000 balanserat, the result and 128 000 reserves and
// liabilities. PREVIOUS.preClosing is that year with the result still on the
// result accounts and nothing on 2099, which is how a year closed in another
// system arrives when its closing entry was never booked.
describe('mapTrialBalancesToK2: comparison year and its closing entry (crm#1080)', () => {
  const NEVER_CLOSED: TrialBalancePair = {
    full: PREVIOUS.preClosing,
    preClosing: PREVIOUS.preClosing,
  }
  const CHECK = 'Stäm av jämförelsetalen mot föregående års fastställda årsredovisning.'
  const DERIVED =
    'Jämförelseåret avslutades aldrig i bokföringen: årets resultat (40000 kr) står kvar på resultatkontona. Årets resultat i jämförelseårets balansräkning är därför hämtat från resultaträkningen.'
  const NOT_EXPLAINED =
    'och skillnaden kan inte förklaras av ett år som aldrig avslutades. Jämförelsetalen visas som de är bokförda: stäm av dem mot föregående års fastställda årsredovisning.'
  const AS_BOOKED =
    'Jämförelsetalen visas som de är bokförda: stäm av dem mot föregående års fastställda årsredovisning.'
  const NOTE_8999 =
    'Konto 8999 (Årets resultat) ingår inte i K2-mappningen: årets resultat beräknas från resultaträkningens summa. Ingen åtgärd behövs.'
  const closed = mapTrialBalancesToK2(CURRENT, PREVIOUS)
  const figures = (res: ReturnType<typeof mapTrialBalancesToK2>) => ({
    rr: res.rr,
    br: res.br,
    totals: res.totals,
  })
  const currentColumn = (res: ReturnType<typeof mapTrialBalancesToK2>) =>
    Object.fromEntries(
      Object.entries({ ...res.rr, ...res.br, ...res.totals }).map(([key, amount]) => [
        key,
        amount.current,
      ]),
    )

  /** 2099 with a balance that came in with the opening balance and never moved. */
  const carriedIn = (credit: number): TrialBalanceRowLike => ({
    ...row('2099', 'Årets resultat', 0, credit),
    period_debit: 0,
    period_credit: 0,
  })
  const withBalanserat = (rows: TrialBalanceRowLike[], credit: number) =>
    rows.map((r) => (r.account_number === '2091' ? { ...r, closing_credit: credit } : r))

  it('(a) closed in Accounted: read from 2099, nothing derived, no notice', () => {
    expect(closed.br['AretsResultatEgetKapital'].previous).toBe(40_000)
    expect(closed.br['BalanseratResultat'].previous).toBe(60_000)
    expect(closed.totals.tillgangar.previous).toBe(253_000)
    expect(closed.totals.egetKapitalSkulder.previous).toBe(253_000)
    expect(closed.warnings).toEqual([])
  })

  it('(b) closed in another system with 8999 against 2099: read from 2099, no notice', () => {
    // exclude-final drops the 8999/2099 voucher from the pre-closing balance.
    const res = mapTrialBalancesToK2(CURRENT, {
      full: [
        ...PREVIOUS.preClosing,
        row('2099', 'Årets resultat', 0, 40_000),
        row('8999', 'Årets resultat', 40_000, 0),
      ],
      preClosing: PREVIOUS.preClosing,
    })
    expect(figures(res)).toEqual(figures(closed))
    expect(res.warnings).toEqual([NOTE_8999])
  })

  it('(c) never closed, nothing on 2099: the books as they stand are out by the result', () => {
    // The ticket, seen without the fix: mapped as a current year the mapper
    // demands the closing instead of deriving it, so this is what is booked.
    const asBooked = mapTrialBalancesToK2(NEVER_CLOSED, null)
    expect(asBooked.br['AretsResultatEgetKapital'].current).toBe(0)
    expect(asBooked.totals.tillgangar.current).toBe(253_000)
    expect(asBooked.totals.egetKapitalSkulder.current).toBe(213_000)
    expect(
      asBooked.totals.tillgangar.current - asBooked.totals.egetKapitalSkulder.current,
    ).toBe(asBooked.totals.aretsResultat.current)
    expect(asBooked.totals.aretsResultat.current).toBe(40_000)
  })

  it('(c) never closed, nothing on 2099: Årets resultat comes from the income statement and the column balances', () => {
    const res = mapTrialBalancesToK2(CURRENT, NEVER_CLOSED)
    expect(res.br['AretsResultatEgetKapital']).toEqual({ current: 120_000, previous: 40_000 })
    expect(res.br['BalanseratResultat']).toEqual({ current: 100_000, previous: 60_000 })
    expect(res.totals.aretsResultat.previous).toBe(40_000)
    expect(res.totals.frittEgetKapital.previous).toBe(100_000)
    expect(res.totals.egetKapital.previous).toBe(125_000)
    expect(res.totals.tillgangar.previous).toBe(253_000)
    expect(res.totals.egetKapitalSkulder.previous).toBe(253_000)
    // Exactly the column the same year shows when it is closed in the books.
    expect(figures(res)).toEqual(figures(closed))
    expect(res.warnings).toEqual([`${DERIVED} ${CHECK}`])
  })

  it('(d) never closed, an earlier result still on 2099: that balance is Balanserat resultat', () => {
    // 15 000 kr of the 60 000 kr retained earnings never left 2099.
    const rows = [...withBalanserat(PREVIOUS.preClosing, 45_000), carriedIn(15_000)]
    const pair = { full: rows, preClosing: rows }

    // As booked, Årets resultat would read the earlier year's 15 000 kr.
    expect(mapTrialBalancesToK2(pair, null).br['AretsResultatEgetKapital'].current).toBe(15_000)

    const res = mapTrialBalancesToK2(CURRENT, pair)
    expect(res.br['AretsResultatEgetKapital'].previous).toBe(40_000)
    expect(res.br['BalanseratResultat'].previous).toBe(60_000)
    expect(res.totals.tillgangar.previous).toBe(253_000)
    expect(res.totals.egetKapitalSkulder.previous).toBe(253_000)
    expect(figures(res)).toEqual(figures(closed))
    expect(res.warnings).toEqual([
      `${DERIVED} Saldot på konto 2099 (15000 kr) fanns redan vid jämförelseårets ingång och visas som Balanserat resultat. ${CHECK}`,
    ])
  })

  it.each([
    ['moved during the year', { period_debit: 0, period_credit: 15_000 }],
    ['of unknown origin (no period activity on the row)', {}],
  ])('(d) never closed, a balance on 2099 %s: not derived, warned', (_label, activity) => {
    const rows = [
      ...withBalanserat(PREVIOUS.preClosing, 45_000),
      { ...row('2099', 'Årets resultat', 0, 15_000), ...activity },
    ]
    const res = mapTrialBalancesToK2(CURRENT, { full: rows, preClosing: rows })
    expect(res.br['AretsResultatEgetKapital'].previous).toBe(15_000)
    expect(res.br['BalanseratResultat'].previous).toBe(45_000)
    expect(res.totals.tillgangar.previous).toBe(253_000)
    expect(res.totals.egetKapitalSkulder.previous).toBe(213_000)
    expect(res.warnings).toEqual([
      `Jämförelseårets resultat enligt resultaträkningen (40000 kr) stämmer inte med konto 2099 (15000 kr), ${NOT_EXPLAINED}`,
      `Jämförelseårets balansräkning balanserar inte: Summa tillgångar 253000 kr ≠ Summa eget kapital och skulder 213000 kr. ${AS_BOOKED}`,
    ])
  })

  it('(e) closed with 8999 against another account than 2099: figures stay as booked, warned', () => {
    // The result went straight to 2098. The column balances, but which post
    // received the result cannot be read from the balances, so nothing moves.
    const rows = [
      ...PREVIOUS.preClosing,
      row('2098', 'Vinst eller förlust från föregående år', 0, 40_000),
      row('8999', 'Årets resultat', 40_000, 0),
    ]
    const res = mapTrialBalancesToK2(CURRENT, { full: rows, preClosing: rows })
    expect(res.br['AretsResultatEgetKapital'].previous).toBe(0)
    expect(res.br['BalanseratResultat'].previous).toBe(100_000)
    expect(res.totals.aretsResultat.previous).toBe(40_000)
    expect(res.totals.tillgangar.previous).toBe(253_000)
    expect(res.totals.egetKapitalSkulder.previous).toBe(253_000)
    expect(res.warnings).toEqual([
      NOTE_8999,
      `Jämförelseårets resultat enligt resultaträkningen (40000 kr) stämmer inte med konto 2099 (0 kr), ${NOT_EXPLAINED}`,
    ])
  })

  it('(f) first fiscal year: no comparison year, and an unbooked result is still demanded', () => {
    const res = mapTrialBalancesToK2(NEVER_CLOSED, null)
    expect(res.br['AretsResultatEgetKapital']).toEqual({ current: 0, previous: null })
    expect(res.totals.tillgangar).toEqual({ current: 253_000, previous: null })
    expect(res.totals.egetKapitalSkulder).toEqual({ current: 213_000, previous: null })
    expect(res.warnings).toEqual([
      'Årets resultat enligt resultaträkningen (40000 kr) stämmer inte med konto 2099 (0 kr). Kontrollera att bokslutet är genomfört (resultatdisposition bokad).',
      'Balansräkningen balanserar inte: Summa tillgångar 253000 kr ≠ Summa eget kapital och skulder 213000 kr (kontrollera-kod 3005).',
    ])
  })

  describe('(g) comparison year with a zero result', () => {
    const zeroResult = (equity: TrialBalanceRowLike[]): TrialBalancePair => {
      const rows = [
        row('1930', 'Bank', 100_000, 0),
        row('2081', 'Aktiekapital', 0, 25_000),
        ...equity,
        row('3010', 'Försäljning', 0, 50_000),
        row('5010', 'Lokalhyra', 50_000, 0),
      ]
      return { full: rows, preClosing: rows }
    }

    it('never closed: there is nothing to derive and nothing to say', () => {
      const res = mapTrialBalancesToK2(
        CURRENT,
        zeroResult([row('2091', 'Balanserad vinst', 0, 75_000)]),
      )
      expect(res.br['AretsResultatEgetKapital'].previous).toBe(0)
      expect(res.br['BalanseratResultat'].previous).toBe(75_000)
      expect(res.totals.tillgangar.previous).toBe(100_000)
      expect(res.totals.egetKapitalSkulder.previous).toBe(100_000)
      expect(res.warnings).toEqual([])
    })

    it('an earlier result still on 2099 is Balanserat resultat, and Årets resultat is 0 kr', () => {
      const res = mapTrialBalancesToK2(
        CURRENT,
        zeroResult([row('2091', 'Balanserad vinst', 0, 45_000), carriedIn(30_000)]),
      )
      expect(res.br['AretsResultatEgetKapital'].previous).toBe(0)
      expect(res.br['BalanseratResultat'].previous).toBe(75_000)
      expect(res.totals.tillgangar.previous).toBe(100_000)
      expect(res.totals.egetKapitalSkulder.previous).toBe(100_000)
      expect(res.warnings).toEqual([
        `Saldot på konto 2099 (30000 kr) fanns redan vid jämförelseårets ingång och visas som Balanserat resultat. ${CHECK}`,
      ])
    })
  })

  it('a difference that is not the unbooked result is never derived away', () => {
    // 1 000 kr on the asset side with no counterpart: the column is out by
    // 41 000 kr, the result is 40 000 kr.
    const rows = [...PREVIOUS.preClosing, row('1510', 'Kundfordringar', 1_000, 0)]
    const res = mapTrialBalancesToK2(CURRENT, { full: rows, preClosing: rows })
    expect(res.br['AretsResultatEgetKapital'].previous).toBe(0)
    expect(res.totals.tillgangar.previous).toBe(254_000)
    expect(res.totals.egetKapitalSkulder.previous).toBe(213_000)
    expect(res.warnings).toEqual([
      `Jämförelseårets resultat enligt resultaträkningen (40000 kr) stämmer inte med konto 2099 (0 kr), ${NOT_EXPLAINED}`,
      `Jämförelseårets balansräkning balanserar inte: Summa tillgångar 254000 kr ≠ Summa eget kapital och skulder 213000 kr. ${AS_BOOKED}`,
    ])
  })

  it('a result that was partly closed is not guessed at', () => {
    // 30 000 kr of the 40 000 kr result was closed against 2099, the rest
    // was booked afterwards and never closed.
    const full = [
      ...PREVIOUS.preClosing,
      { ...row('2099', 'Årets resultat', 0, 30_000), period_debit: 0, period_credit: 30_000 },
      row('8999', 'Årets resultat', 30_000, 0),
    ]
    const res = mapTrialBalancesToK2(CURRENT, { full, preClosing: PREVIOUS.preClosing })
    expect(res.br['AretsResultatEgetKapital'].previous).toBe(30_000)
    expect(res.totals.tillgangar.previous).toBe(253_000)
    expect(res.totals.egetKapitalSkulder.previous).toBe(243_000)
    expect(res.warnings).toEqual([
      NOTE_8999,
      `Jämförelseårets resultat enligt resultaträkningen (40000 kr) stämmer inte med konto 2099 (30000 kr), ${NOT_EXPLAINED}`,
      `Jämförelseårets balansräkning balanserar inte: Summa tillgångar 253000 kr ≠ Summa eget kapital och skulder 243000 kr. ${AS_BOOKED}`,
    ])
  })

  it('leaves the current year column untouched in every shape', () => {
    const rows = [...withBalanserat(PREVIOUS.preClosing, 45_000), carriedIn(15_000)]
    for (const previous of [NEVER_CLOSED, { full: rows, preClosing: rows }]) {
      expect(currentColumn(mapTrialBalancesToK2(CURRENT, previous))).toEqual(currentColumn(closed))
    }
  })

  it('rounds and smooths a derived result like a booked one', () => {
    // Result 500,50 kr on two posts of ,25: 2099 would round to 501 and the
    // income statement to 300 + 200. The derived post goes through the same
    // smoothing, so both statements say 501 and the column ties at 1 001.
    const rows = [
      row('1930', 'Bank', 1_000.5, 0),
      row('2081', 'Aktiekapital', 0, 500),
      row('3010', 'Försäljning', 0, 300.25),
      row('3990', 'Övriga intäkter', 0, 200.25),
    ]
    const res = mapTrialBalancesToK2(CURRENT, { full: rows, preClosing: rows })
    expect(res.br['AretsResultatEgetKapital'].previous).toBe(501)
    expect(res.totals.aretsResultat.previous).toBe(501)
    expect(res.totals.tillgangar.previous).toBe(1_001)
    expect(res.totals.egetKapitalSkulder.previous).toBe(1_001)
    expect(res.warnings).toEqual([`${DERIVED.replace('40000', '501')} ${CHECK}`])
  })

  it('derives a prior year mapped on its own only when the caller says it is one', () => {
    // The flerårsöversikt maps each earlier year without a comparison year.
    const history = mapTrialBalancesToK2(NEVER_CLOSED, null, { currentIsPriorYear: true })
    expect(history.br['AretsResultatEgetKapital'].current).toBe(40_000)
    expect(history.totals.egetKapital.current).toBe(125_000)
    expect(history.totals.tillgangar.current).toBe(253_000)
    expect(history.totals.egetKapitalSkulder.current).toBe(253_000)
    expect(history.totals.tillgangar.previous).toBeNull()
  })
})
