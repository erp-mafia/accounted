import { describe, expect, it } from 'vitest'
import {
  buildEquitySpecification,
  computeEquitySpecificationYear,
  equityAccountNumbers,
  equitySpecificationIssues,
  equitySpecificationTable,
  k2EquityPosts,
  k2EquityTableInput,
  type EquityEntry,
  type EquityYearInput,
} from '../equity-specification'
import { K2_BR_LAYOUT } from '@/lib/bokslut/ixbrl/k2-mapper'

const POSTS = k2EquityPosts('aktiebolag')

function tb(account: string, opening: number, closing: number) {
  // credit-positive amounts in, debit/credit columns out
  return {
    account_number: account,
    opening_debit: opening < 0 ? -opening : 0,
    opening_credit: opening > 0 ? opening : 0,
    closing_debit: closing < 0 ? -closing : 0,
    closing_credit: closing > 0 ? closing : 0,
  }
}

let seq = 0
function entry(lines: Array<[string, number, number]>, extra: Partial<EquityEntry> = {}): EquityEntry {
  seq += 1
  return {
    id: extra.id ?? `je-${seq}`,
    voucher: extra.voucher ?? `A${seq}`,
    entry_date: extra.entry_date ?? '2026-03-01',
    description: extra.description ?? null,
    source_type: extra.source_type ?? 'manual',
    reverses_id: extra.reverses_id ?? null,
    lines: lines.map(([account_number, debit, credit]) => ({ account_number, debit, credit })),
  }
}

function year(tbRows: EquityYearInput['tbRows'], entries: EquityEntry[], extra: Partial<EquityYearInput> = {}): EquityYearInput {
  return {
    fiscal_period_id: 'fp-2026',
    name: '2026',
    period_start: '2026-01-01',
    period_end: '2026-12-31',
    tbRows,
    entries,
    ...extra,
  }
}

function balanceSheet(current: Record<string, number>, previous: Record<string, number> | null) {
  const concepts = new Set([...Object.keys(current), ...Object.keys(previous ?? {})])
  const br: Record<string, { current: number; previous: number | null }> = {}
  for (const concept of concepts) {
    br[concept] = { current: current[concept] ?? 0, previous: previous ? previous[concept] ?? 0 : null }
  }
  const sum = (values: Record<string, number>) => Object.values(values).reduce((a, b) => a + b, 0)
  return {
    br,
    totals: { egetKapital: { current: sum(current), previous: previous ? sum(previous) : null } },
  } as unknown as Parameters<typeof equitySpecificationIssues>[1]
}

describe('k2EquityPosts', () => {
  it('covers exactly the equity concepts of the K2 balance sheet, with the mapper ranges', () => {
    const heading = K2_BR_LAYOUT.equityLiabilities.find((e) => 'sections' in e && e.key === 'egetKapital') as unknown as {
      sections: Array<{ concepts: readonly string[] }>
    }
    const expected = heading.sections.flatMap((s) => s.concepts).filter((c) => c !== 'Medlemsinsatser' && c !== 'Forlagsinsatser')
    expect(POSTS.map((p) => p.concept)).toEqual(expected)
    expect(POSTS.find((p) => p.concept === 'Reservfond')!.ranges).toContainEqual({ start: '2088', end: '2089' })
    expect(equityAccountNumbers(POSTS)).toEqual(Array.from({ length: 20 }, (_, i) => String(2080 + i)))
  })

  it('gives an ekonomisk förening its insatser posts and no share capital', () => {
    const concepts = k2EquityPosts('ekonomisk_forening').map((p) => p.concept)
    expect(concepts).toContain('Medlemsinsatser')
    expect(concepts).toContain('Forlagsinsatser')
    expect(concepts).not.toContain('Aktiekapital')
  })
})

describe('computeEquitySpecificationYear: classification by account and counter-movement', () => {
  it('reads the year from the books: disposition, dividend, result', () => {
    const entries = [
      // Last year's result balanced (2099 -> 2098) at year start.
      entry([['2099', 120_000, 0], ['2098', 0, 120_000]], { source_type: 'result_appropriation' }),
      // The dividend the stämma decided, booked to 2898 and paid.
      entry([['2098', 50_000, 0], ['2898', 0, 50_000]]),
      // The year's result closed into 2099.
      entry([['8999', 90_000, 0], ['2099', 0, 90_000]], { source_type: 'year_end' }),
    ]
    const spec = computeEquitySpecificationYear(
      POSTS,
      year([tb('2081', 25_000, 25_000), tb('2098', 200_000, 270_000), tb('2099', 120_000, 90_000)], entries),
    )
    const byConcept = Object.fromEntries(spec.posts.map((p) => [p.concept, p]))
    expect(byConcept.BalanseratResultat).toMatchObject({ opening: 200_000, closing: 270_000, movements: { resultatdisposition: 120_000, utdelning: -50_000 } })
    expect(byConcept.AretsResultatEgetKapital).toMatchObject({ opening: 120_000, closing: 90_000, movements: { resultatdisposition: -120_000, arets_resultat: 90_000 } })
    expect(byConcept.Aktiekapital).toMatchObject({ opening: 25_000, closing: 25_000, movements: {} })
    expect(spec.totals).toEqual({
      opening: 345_000,
      closing: 385_000,
      movements: { utdelning: -50_000, arets_resultat: 90_000 },
    })
    expect(spec.unclassified).toEqual([])
  })

  it('names an aktieägartillskott a tillskott, not a nyemission (the old residual guess)', () => {
    const entries = [entry([['1930', 100_000, 0], ['2093', 0, 100_000]])]
    const spec = computeEquitySpecificationYear(POSTS, year([tb('2093', 0, 100_000)], entries))
    expect(spec.totals.movements).toEqual({ aktieagartillskott: 100_000 })
  })

  it('reads a share issue at a premium as nyemission on both posts', () => {
    const entries = [entry([['1930', 150_000, 0], ['2081', 0, 50_000], ['2097', 0, 100_000]])]
    const spec = computeEquitySpecificationYear(POSTS, year([tb('2081', 50_000, 100_000), tb('2097', 0, 100_000)], entries))
    const byConcept = Object.fromEntries(spec.posts.map((p) => [p.concept, p.movements]))
    expect(byConcept.Aktiekapital).toEqual({ nyemission: 50_000 })
    expect(byConcept.Overkursfond).toEqual({ nyemission: 100_000 })
  })

  it('reads a fondemission and other transfers between equity posts as omföringar', () => {
    const entries = [
      entry([['2098', 50_000, 0], ['2081', 0, 50_000]]),
      entry([['2086', 10_000, 0], ['2098', 0, 10_000]]),
    ]
    const spec = computeEquitySpecificationYear(
      POSTS,
      year([tb('2081', 50_000, 100_000), tb('2086', 10_000, 0), tb('2098', 100_000, 60_000)], entries),
    )
    expect(spec.totals.movements).toEqual({})
    const byConcept = Object.fromEntries(spec.posts.map((p) => [p.concept, p.movements]))
    expect(byConcept.Aktiekapital).toEqual({ fondemission: 50_000 })
    expect(byConcept.Reservfond).toEqual({ omforing: -10_000 })
    expect(byConcept.BalanseratResultat).toEqual({ fondemission: -50_000, omforing: 10_000 })
  })

  it('splits a combined disposition and dividend into its two kinds', () => {
    const entries = [entry([['2099', 100_000, 0], ['2098', 0, 70_000], ['2898', 0, 30_000]])]
    const spec = computeEquitySpecificationYear(POSTS, year([tb('2098', 0, 70_000), tb('2099', 100_000, 0)], entries))
    const result = spec.posts.find((p) => p.concept === 'AretsResultatEgetKapital')!
    expect(result.movements).toEqual({ utdelning: -30_000, resultatdisposition: -70_000 })
    expect(spec.totals.movements).toEqual({ utdelning: -30_000 })
  })

  it('leaves a direct-to-equity correction unclassified and says so, never calling it a dividend', () => {
    const warnings: string[] = []
    const entries = [entry([['2091', 40_000, 0], ['1510', 0, 40_000]], { id: 'je-fel', voucher: 'A17' })]
    const spec = computeEquitySpecificationYear(POSTS, year([tb('2091', 100_000, 60_000)], entries), {}, warnings)
    expect(spec.totals.movements).toEqual({ ovrigt: -40_000 })
    expect(spec.unclassified).toEqual([
      expect.objectContaining({ journal_entry_id: 'je-fel', voucher: 'A17', amount: -40_000 }),
    ])
    expect(warnings.join(' ')).toContain('A17')
  })

  it('takes the user\'s classification of such a verifikat', () => {
    const entries = [entry([['2091', 40_000, 0], ['1510', 0, 40_000]], { id: 'je-fel' })]
    const spec = computeEquitySpecificationYear(POSTS, year([tb('2091', 100_000, 60_000)], entries), { 'je-fel': 'rattelse_av_fel' })
    expect(spec.totals.movements).toEqual({ rattelse_av_fel: -40_000 })
    expect(spec.unclassified).toEqual([])
  })

  it('gives a storno the kind of the verifikat it reverses', () => {
    const original = entry([['1930', 100_000, 0], ['2093', 0, 100_000]], { id: 'je-orig' })
    const storno = entry([['1930', 0, 100_000], ['2093', 100_000, 0]], { id: 'je-storno', reverses_id: 'je-orig', source_type: 'storno' })
    const spec = computeEquitySpecificationYear(POSTS, year([tb('2093', 0, 0)], [storno, original]))
    expect(spec.posts).toEqual([])
    expect(spec.totals.movements).toEqual({})
  })

  it('shows what the verifikat cannot explain as Övriga förändringar with a warning', () => {
    const warnings: string[] = []
    const spec = computeEquitySpecificationYear(POSTS, year([tb('2091', 100_000, 90_000)], []), {}, warnings)
    expect(spec.totals.movements).toEqual({ ovrigt: -10_000 })
    expect(warnings[0]).toContain('kunde inte knytas')
  })

  it('presents a comparison year never closed here: result derived, carried 2099 balance moved to balanserat', () => {
    // 2099 held 30 000 carried in and untouched; the year's result 80 000 is
    // still on the result accounts. The mapper presents Årets resultat 80 000
    // and Balanserat resultat 130 000 (100 000 + the carried 30 000).
    const spec = computeEquitySpecificationYear(
      POSTS,
      year([tb('2098', 100_000, 100_000), tb('2099', 30_000, 30_000)], [], {
        balanceSheetClosing: { BalanseratResultat: 130_000, AretsResultatEgetKapital: 80_000 },
      }),
    )
    expect(spec.derived).toBe(true)
    const byConcept = Object.fromEntries(spec.posts.map((p) => [p.concept, p]))
    expect(byConcept.BalanseratResultat).toMatchObject({ closing: 130_000, movements: { omforing: 30_000 } })
    expect(byConcept.AretsResultatEgetKapital).toMatchObject({
      opening: 30_000,
      closing: 80_000,
      movements: { omforing: -30_000, arets_resultat: 80_000 },
    })
    expect(spec.totals.movements).toEqual({ arets_resultat: 80_000 })
  })
})

describe('buildEquitySpecification and integrity', () => {
  const current = year(
    [tb('2081', 25_000, 25_000), tb('2098', 200_000, 320_000), tb('2099', 120_000, 90_000)],
    [
      entry([['2099', 120_000, 0], ['2098', 0, 120_000]]),
      entry([['8999', 90_000, 0], ['2099', 0, 90_000]], { source_type: 'year_end' }),
    ],
  )
  const previous = year(
    [tb('2081', 25_000, 25_000), tb('2098', 200_000, 200_000), tb('2099', 0, 120_000)],
    [entry([['8999', 120_000, 0], ['2099', 0, 120_000]], { source_type: 'year_end' })],
    { fiscal_period_id: 'fp-2025', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' },
  )
  const mapping = balanceSheet(
    { Aktiekapital: 25_000, BalanseratResultat: 320_000, AretsResultatEgetKapital: 90_000 },
    { Aktiekapital: 25_000, BalanseratResultat: 200_000, AretsResultatEgetKapital: 120_000 },
  )

  it('builds both years, lists the kinds present and ties to the balance sheet', () => {
    const spec = buildEquitySpecification({ posts: POSTS, current, previous, balanceSheet: mapping })
    expect(spec.placement).toBe('management_report')
    expect(spec.kinds).toEqual(['resultatdisposition', 'arets_resultat'])
    expect(spec.previous?.totals.closing).toBe(345_000)
    expect(spec.current.totals.closing).toBe(435_000)
    expect(spec.warnings).toEqual([])
    expect(equitySpecificationIssues(spec, mapping)).toEqual([])
  })

  it('fails loudly when the balance sheet shows another equity', () => {
    const drifted = balanceSheet(
      { Aktiekapital: 25_000, BalanseratResultat: 319_000, AretsResultatEgetKapital: 90_000 },
      { Aktiekapital: 25_000, BalanseratResultat: 200_000, AretsResultatEgetKapital: 120_000 },
    )
    const spec = buildEquitySpecification({ posts: POSTS, current, previous, balanceSheet: drifted })
    expect(spec.integrity_issues).toEqual([
      'Balanserat resultat 2026: bokföringen 320 000 kr, balansräkningen 319 000 kr.',
      'Eget kapital 2026: bokföringen 435 000 kr, balansräkningen 434 000 kr.',
    ])
    expect(equitySpecificationIssues(spec, drifted)).toHaveLength(2)
    // A specification built against one balance sheet does not tie to another.
    const clean = buildEquitySpecification({ posts: POSTS, current, previous, balanceSheet: mapping })
    expect(equitySpecificationIssues(clean, drifted)).toEqual([
      'Balanserat resultat 2026: specifikationen 320 000 kr, balansräkningen 319 000 kr.',
      'Eget kapital 2026: specifikationen 435 000 kr, balansräkningen 434 000 kr.',
    ])
  })

  it('warns when the year does not open on last year\'s close', () => {
    const broken = { ...current, tbRows: [tb('2081', 25_000, 25_000), tb('2098', 190_000, 310_000), tb('2099', 120_000, 90_000)] }
    const spec = buildEquitySpecification({
      posts: POSTS,
      current: broken,
      previous,
      balanceSheet: balanceSheet(
        { Aktiekapital: 25_000, BalanseratResultat: 310_000, AretsResultatEgetKapital: 90_000 },
        { Aktiekapital: 25_000, BalanseratResultat: 200_000, AretsResultatEgetKapital: 120_000 },
      ),
    })
    // The table opens on last year's close (the comparison column) and shows
    // the gap the books leave as Övriga förändringar, with a warning.
    expect(spec.current.posts.find((p) => p.concept === 'BalanseratResultat')).toMatchObject({
      opening: 200_000,
      closing: 310_000,
      movements: { resultatdisposition: 120_000, ovrigt: -10_000 },
    })
    expect(spec.warnings.join(' ')).toContain('kontrollera att året öppnar på föregående års utgående balans')
  })

  it('renders the year as one table from opening to closing', () => {
    const spec = buildEquitySpecification({ posts: POSTS, current, previous, balanceSheet: mapping })
    const table = equitySpecificationTable(spec.current)
    expect(table.columns.map((c) => c.label)).toEqual(['Aktiekapital', 'Balanserat resultat', 'Årets resultat'])
    expect(table.rows.map((r) => r.label)).toEqual([
      'Belopp vid årets ingång',
      'Disposition enligt stämmans beslut',
      'Årets resultat',
      'Belopp vid årets utgång',
    ])
    expect(table.rows[1]).toMatchObject({ cells: [0, 120_000, -120_000], total: 0 })
    expect(table.rows[3]).toMatchObject({ cells: [25_000, 320_000, 90_000], total: 435_000 })
  })

  it('names the rows as the K2 taxonomy does for a K2 year, with the same figures', () => {
    const spec = buildEquitySpecification({ posts: POSTS, current, previous, balanceSheet: mapping })
    const k2 = equitySpecificationTable(spec.current, 'k2')
    expect(k2.rows.map((r) => r.label)).toEqual([
      'Belopp vid årets ingång',
      'Balanseras i ny räkning',
      'Årets resultat',
      'Belopp vid årets utgång',
    ])
    const general = equitySpecificationTable(spec.current)
    expect(k2.rows.map((r) => [r.key, r.cells, r.total])).toEqual(general.rows.map((r) => [r.key, r.cells, r.total]))
  })

  it('names the K2 row labels on the report only when asked to, so an older report is told apart', () => {
    expect(buildEquitySpecification({ posts: POSTS, current, previous, balanceSheet: mapping })).not.toHaveProperty('row_labels')
    expect(buildEquitySpecification({ posts: POSTS, current, previous, balanceSheet: mapping, rowLabels: 'k2' }).row_labels).toBe('k2')
  })
})

describe('presentation in whole kronor', () => {
  it('rounds the movements so each column ties to the balance sheet\'s whole-krona figure', () => {
    const current = year(
      [tb('2098', 100_000.4, 100_100.6), tb('2099', 0, 0)],
      [entry([['1930', 100.2, 0], ['2098', 0, 100.2]])],
    )
    const spec = buildEquitySpecification({
      posts: POSTS,
      current,
      previous: null,
      balanceSheet: balanceSheet({ BalanseratResultat: 100_101 }, null),
    })
    const post = spec.current.posts.find((p) => p.concept === 'BalanseratResultat')!
    expect(post).toMatchObject({ opening: 100_000, closing: 100_101 })
    expect(post.opening + Object.values(post.movements).reduce((a, b) => a + (b ?? 0), 0)).toBe(post.closing)
    expect(spec.integrity_issues).toEqual([])
  })

  it('rounds a figure and its negative alike, as the balance sheet does: a result on 50 öre leaves no krona on its disposition', () => {
    // Last year's result of 40 000,50 is carried forward and this year's is
    // a loss of 20 000,50. The balance sheet rounds a half away from zero
    // whatever the sign (ixbrl/whole-kronor.ts): 40 001 and -20 001.
    const current = year(
      [tb('2081', 25_000, 25_000), tb('2098', 60_000, 100_000.5), tb('2099', 40_000.5, -20_000.5)],
      [
        entry([['2099', 40_000.5, 0], ['2098', 0, 40_000.5]]),
        entry([['2099', 20_000.5, 0], ['8999', 0, 20_000.5]], { source_type: 'year_end' }),
      ],
    )
    const previous = year(
      [tb('2081', 25_000, 25_000), tb('2098', 60_000, 60_000), tb('2099', 0, 40_000.5)],
      [entry([['8999', 40_000.5, 0], ['2099', 0, 40_000.5]], { source_type: 'year_end' })],
      { fiscal_period_id: 'fp-2025', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' },
    )
    const mapping = balanceSheet(
      { Aktiekapital: 25_000, BalanseratResultat: 100_001, AretsResultatEgetKapital: -20_001 },
      { Aktiekapital: 25_000, BalanseratResultat: 60_000, AretsResultatEgetKapital: 40_001 },
    )
    const spec = buildEquitySpecification({ posts: POSTS, current, previous, balanceSheet: mapping })
    const movements = (concept: string) => spec.current.posts.find((p) => p.concept === concept)?.movements
    // What leaves Årets resultat is what reaches Balanserat resultat, and
    // the year's result is the balance sheet's, not a krona beside it.
    expect(movements('BalanseratResultat')).toEqual({ resultatdisposition: 40_001 })
    expect(movements('AretsResultatEgetKapital')).toEqual({ resultatdisposition: -40_001, arets_resultat: -20_001 })
    expect(spec.current.totals.movements).toEqual({ arets_resultat: -20_001 })
    expect(spec.warnings).toEqual([])
    expect(equitySpecificationIssues(spec, mapping)).toEqual([])
  })
})

describe('k2EquityTableInput', () => {
  it('reproduces the old derivation for an ordinary year (balansering, dividend, result)', () => {
    const current = year(
      [tb('2081', 25_000, 25_000), tb('2098', 200_000, 270_000), tb('2099', 120_000, 90_000)],
      [
        entry([['2099', 120_000, 0], ['2098', 0, 120_000]]),
        entry([['2098', 50_000, 0], ['2898', 0, 50_000]]),
        entry([['8999', 90_000, 0], ['2099', 0, 90_000]]),
      ],
    )
    const previous = year([tb('2081', 25_000, 25_000), tb('2098', 200_000, 200_000), tb('2099', 0, 120_000)], [
      entry([['8999', 120_000, 0], ['2099', 0, 120_000]]),
    ])
    const input = k2EquityTableInput(
      buildEquitySpecification({
        posts: POSTS,
        current,
        previous,
        balanceSheet: balanceSheet(
          { Aktiekapital: 25_000, BalanseratResultat: 270_000, AretsResultatEgetKapital: 90_000 },
          { Aktiekapital: 25_000, BalanseratResultat: 200_000, AretsResultatEgetKapital: 120_000 },
        ),
      }),
    )
    expect(input).toEqual({
      aktiekapital: { ib: 25_000, ub: 25_000 },
      balanseratResultat: { ib: 200_000, ub: 270_000 },
      aretsResultat: { ib: 120_000, ub: 90_000 },
      totalt: { ib: 345_000, ub: 385_000 },
      ovrigaPoster: { ib: 0, ub: 0 },
      balanserasINyRakning: 120_000,
      utdelning: 50_000,
      forandringAktiekapital: 0,
      ovrigForandringBalanserat: 0,
      aretsResultatRorelse: 90_000,
    })
  })

  it('no longer calls a fall in balanserat resultat that is not a dividend a dividend', () => {
    const current = year(
      [tb('2098', 200_000, 160_000), tb('2099', 0, 0)],
      [entry([['2098', 40_000, 0], ['1510', 0, 40_000]])],
    )
    const input = k2EquityTableInput(
      buildEquitySpecification({ posts: POSTS, current, previous: null, balanceSheet: balanceSheet({ BalanseratResultat: 160_000 }, null) }),
    )
    expect(input.utdelning).toBe(0)
    expect(input.ovrigForandringBalanserat).toBe(-40_000)
  })

  it('does not read an imported share capital as a nyemission in the first year in Accounted', () => {
    const current = year([tb('2081', 25_000, 25_000)], [])
    const input = k2EquityTableInput(
      buildEquitySpecification({ posts: POSTS, current, previous: null, balanceSheet: balanceSheet({ Aktiekapital: 25_000 }, null) }),
    )
    expect(input.forandringAktiekapital).toBe(0)
  })
})
