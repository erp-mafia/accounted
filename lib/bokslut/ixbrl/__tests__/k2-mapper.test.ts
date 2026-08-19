import { describe, expect, it } from 'vitest'
import { mapTrialBalancesToK2, type TrialBalanceRowLike } from '../k2-mapper'
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
