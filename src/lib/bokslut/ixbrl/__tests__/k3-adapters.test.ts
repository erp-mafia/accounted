import { describe, expect, it } from 'vitest'
import {
  k3BalanceSheetSource,
  k3CashFlowFromStatement,
  k3CashFlowFromSummary,
  k3CashFlowInput,
  k3ConceptAmounts,
  k3EquityFromClosingBalances,
  k3EquityFromSpecification,
  k3EquityInput,
  k3ForvaltningsberattelseItems,
} from '../k3-adapters'
import { getRegistry } from '../taxonomy/registry'

const K3 = getRegistry('k3-ab-2021-10-31')

describe('K3 balance sheet posts', () => {
  it('tells a K3 presentation from a plain K2 mapping', () => {
    expect(k3BalanceSheetSource({ presentation: 'k3', br: {} })).toBe('k3_presentation')
    expect(k3BalanceSheetSource({ br: {} })).toBe('k2_mapping')
  })

  it('renames the K2 names the K3 forms do not use, adding into an existing K3 post', () => {
    const { rr, br } = k3ConceptAmounts(
      { OvrigaBokslutsdispositioner: { current: -1_000, previous: null }, Nettoomsattning: { current: 5, previous: 4 } },
      {
        OvrigaObeskattadeReserver: { current: 2_000, previous: 1_000 },
        AndraObeskattadeReserver: { current: 500, previous: null },
        ForskottImmateriellaAnlaggningstillgangar: { current: 300, previous: 0 },
      },
    )
    expect(rr).toEqual({ AndraBokslutsdispositioner: { current: -1_000, previous: null }, Nettoomsattning: { current: 5, previous: 4 } })
    expect(br).toEqual({
      AndraObeskattadeReserver: { current: 2_500, previous: 1_000 },
      PagaendeUtvecklingsarbetenForskottImmateriellaAnlaggningstillgangar: { current: 300, previous: 0 },
    })
    for (const concept of [...Object.keys(rr), ...Object.keys(br)]) expect(K3.concepts[concept]).toBeDefined()
  })
})

describe('equity specification', () => {
  const br = {
    Aktiekapital: { current: 25_000, previous: 25_000 },
    BalanseratResultat: { current: 100_000, previous: 60_000 },
    AretsResultatEgetKapital: { current: 120_000, previous: 40_000 },
  }

  it('takes the ledger specification in whole kronor, closing at the balance sheet figure', () => {
    const equity = k3EquityFromSpecification(
      {
        kinds: ['resultatdisposition', 'arets_resultat', 'okand'],
        current: {
          posts: [
            {
              concept: 'BalanseratResultat',
              label: 'Balanserat resultat',
              bound: false,
              opening: 60_000.4,
              closing: 100_000.4,
              movements: { resultatdisposition: 39_999.6, utdelning: -0.2 },
            },
          ],
        },
      },
      br,
    )
    expect(equity.source).toBe('ledger')
    expect(equity.kinds).toEqual([
      { kind: 'resultatdisposition', label: 'Disposition enligt stämmans beslut' },
      { kind: 'arets_resultat', label: 'Årets resultat' },
      { kind: 'okand', label: 'okand' },
    ])
    expect(equity.posts).toEqual([
      {
        concept: 'BalanseratResultat',
        label: 'Balanserat resultat',
        bound: false,
        opening: 60_000,
        closing: 100_000,
        movements: { resultatdisposition: 40_000, utdelning: 0 },
      },
    ])
    expect(Object.is(equity.posts[0].movements.utdelning, -0)).toBe(false)
  })

  it('keeps the placement and maps the jämförelseår to last year’s balance sheet', () => {
    const post = { concept: 'BalanseratResultat', label: 'Balanserat resultat', bound: false, opening: 1, closing: 2, movements: {} }
    const separate = k3EquityFromSpecification(
      { kinds: [], placement: 'separate_statement', current: { posts: [post] }, previous: { posts: [post] } },
      br,
    )
    expect(separate.placement).toBe('separate_statement')
    expect(separate.posts[0].closing).toBe(100_000)
    expect(separate.previous?.[0].closing).toBe(60_000)
    const inReport = k3EquityFromSpecification({ kinds: [], current: { posts: [post] } }, br)
    expect(inReport.placement).toBe('management_report')
    expect(inReport.previous).toBeNull()
  })

  it('falls back to movements read off the balances', () => {
    const equity = k3EquityFromClosingBalances({
      ...br,
      Aktiekapital: { current: 50_000, previous: 25_000 },
      BalanseratResultat: { current: 90_000, previous: 60_000 },
      Reservfond: { current: 1_000, previous: 0 },
    })
    expect(equity.source).toBe('closing_balances')
    expect(equity.placement).toBe('management_report')
    expect(equity.previous).toBeNull()
    const byConcept = Object.fromEntries(equity.posts.map((post) => [post.concept, post.movements]))
    expect(byConcept).toEqual({
      Aktiekapital: { nyemission: 25_000 },
      Reservfond: { ovrigt: 1_000 },
      BalanseratResultat: { resultatdisposition: 40_000, utdelning: -10_000 },
      AretsResultatEgetKapital: { resultatdisposition: -40_000, arets_resultat: 120_000 },
    })
    for (const post of equity.posts) {
      const moved = Object.values(post.movements).reduce((sum, amount) => sum + amount, 0)
      expect(post.opening + moved).toBe(post.closing)
    }
  })

  it('labels the rows as the year\'s regelverk prints them: the K2 taxonomy\'s own rubriker for a K2 year', () => {
    const spec = {
      kinds: ['resultatdisposition', 'utdelning', 'aktieagartillskott', 'aterbetalt_tillskott', 'fondemission', 'uppskrivning', 'omforing', 'insatser_inbetalda'],
      current: { posts: [] },
    }
    const labels = (framework?: 'k2' | 'k3') => k3EquityFromSpecification(spec, br, framework).kinds.map((kind) => kind.label)
    expect(labels('k2')).toEqual([
      'Balanseras i ny räkning',
      'Vinstutdelning',
      'Erhållna aktieägartillskott',
      'Återbetalning av aktieägartillskott',
      'Fondemission',
      'Uppskrivning av anläggningstillgång',
      // No row of its own in the K2 taxonomy: the general label.
      'Omföring mellan poster i eget kapital',
      'Inbetalda insatser',
    ])
    expect(labels()).toEqual(labels('k3'))
    expect(labels('k3').slice(0, 4)).toEqual(['Disposition enligt stämmans beslut', 'Utdelning', 'Erhållna tillskott', 'Återbetalda tillskott'])
    // The same source as the PDF's table, so the two documents name a row alike.
    expect(k3EquityInput({ equity_specification: spec }, br, 'k2').kinds[0].label).toBe('Balanseras i ny räkning')
  })

  it('uses the report’s specification when it has one, else the fallback', () => {
    const spec = { kinds: ['arets_resultat'], current: { posts: [] } }
    expect(k3EquityInput({ equity_specification: spec }, br).source).toBe('ledger')
    expect(k3EquityInput({}, br).source).toBe('closing_balances')
    expect(k3EquityInput({ equity_specification: { kinds: 'x' } }, br).source).toBe('closing_balances')
    expect(k3EquityInput(null, br).source).toBe('closing_balances')
  })
})

describe('kassaflödesanalys', () => {
  it('maps a chapter 7 statement line by line, every concept in the K3 registry', () => {
    const cashFlow = k3CashFlowFromStatement({
      current: { amounts: { rorelseresultat: 100.4, erlagd_ranta: -50, likvida_medel_ub: 10 }, reconciliation: { is_reconciled: true } },
      previous: { amounts: { rorelseresultat: 80 }, reconciliation: { is_reconciled: false } },
    })
    expect(cashFlow.source).toBe('chapter7')
    expect(cashFlow.reconciled).toBe(false)
    const byKey = Object.fromEntries(cashFlow.rows.map((row) => [row.key, row]))
    expect(byKey.rorelseresultat).toMatchObject({ current: 100, previous: 80, concept: 'Rorelseresultat' })
    expect(byKey.erlagd_ranta).toMatchObject({ current: -50, previous: 0 })
    expect(byKey.likvida_medel_ib.instant).toBe('start')
    expect(byKey.likvida_medel_ub.instant).toBe('end')
    for (const row of cashFlow.rows) if (row.concept) expect(K3.concepts[row.concept], row.concept).toBeDefined()
  })

  it('leaves the comparative year empty when the statement has none', () => {
    const cashFlow = k3CashFlowFromStatement({ current: { amounts: {}, reconciliation: { is_reconciled: true } }, previous: null })
    expect(cashFlow.reconciled).toBe(true)
    expect(cashFlow.rows.every((row) => row.previous === null)).toBe(true)
  })

  it('maps the summary report, tagging only lines with a matching concept', () => {
    const cashFlow = k3CashFlowFromSummary({
      lopande: {
        resultat_efter_finansiella_poster: 1_000,
        avskrivningar: 200,
        ovriga_ej_kassaflodesposter: 0,
        skatt_betald: -100,
        delta_kortfristiga_fordringar: -50,
        total: 1_050,
      },
      investerings: { forvarv_anlaggningar: -500, total: -500 },
      finansierings: { delta_lan: 100, total: 100 },
      total_cash_flow: 650,
      reconciliation: { opening_cash_1xxx: 1_000, closing_cash_1xxx: 1_650, is_reconciled: true },
    })
    expect(cashFlow.source).toBe('summary')
    const byKey = Object.fromEntries(cashFlow.rows.map((row) => [row.key, row]))
    expect(byKey.kassaflode_fore_rorelsekapital.current).toBe(1_100)
    expect(byKey.forvarv_anlaggningar).toMatchObject({ concept: null, current: -500 })
    expect(byKey.forandring_lan).toMatchObject({ concept: null, current: 100 })
    expect(byKey.likvida_medel_ub).toMatchObject({ concept: 'LikvidaMedel', instant: 'end', current: 1_650 })
    for (const row of cashFlow.rows) if (row.concept) expect(K3.concepts[row.concept], row.concept).toBeDefined()
  })

  it('reads the report: none, a chapter 7 statement, or the summary', () => {
    expect(k3CashFlowInput({})).toBeNull()
    expect(k3CashFlowInput({ kassaflodesanalys: null })).toBeNull()
    const statement = { current: { amounts: {}, reconciliation: { is_reconciled: true } }, previous: null }
    expect(k3CashFlowInput({ kassaflodesanalys: { statement } })?.source).toBe('chapter7')
    const summary = {
      lopande: {},
      investerings: {},
      finansierings: {},
      total_cash_flow: 0,
      reconciliation: { opening_cash_1xxx: 0, closing_cash_1xxx: 0, is_reconciled: true },
    }
    expect(k3CashFlowInput({ kassaflodesanalys: summary })?.source).toBe('summary')
  })
})

describe('förvaltningsberättelse items', () => {
  it('keeps the well-formed items and nothing else', () => {
    expect(k3ForvaltningsberattelseItems({})).toEqual([])
    expect(
      k3ForvaltningsberattelseItems({
        k3_forvaltningsberattelse: [
          { concept: 'UppgiftAgareMerAnTioProcentAndelarRoster', heading: 'Ägarförhållanden', text: 'Ägs av Moder AB.' },
          { heading: 'Utan begrepp', text: 'Text.' },
          { concept: 'X', heading: 'Utan text' },
          null,
        ],
      }),
    ).toEqual([
      { concept: 'UppgiftAgareMerAnTioProcentAndelarRoster', heading: 'Ägarförhållanden', text: 'Ägs av Moder AB.' },
      { concept: null, heading: 'Utan begrepp', text: 'Text.' },
    ])
  })
})
