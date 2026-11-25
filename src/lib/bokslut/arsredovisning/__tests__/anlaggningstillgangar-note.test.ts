import { describe, it, expect } from 'vitest'
import {
  buildAnlaggningstillgangarNote,
  computeRollforwardTotals,
  depreciationPrincipleLines,
  depreciationPrinciples,
  isDepreciationPrincipleRow,
  holdsWriteDowns,
  _buildRollforwardForTests,
  type AnlaggningAsset,
} from '../anlaggningstillgangar-note'

const PERIOD_START = '2025-01-01'
const PERIOD_END = '2025-12-31'

// Depreciation figures are resolved upstream (asset-note-figures.ts) from
// posted schedules; this suite supplies them and pins the aggregation and
// formatting only. The exact-amount assertions replace the old approximate
// bands: the builder must pass figures through verbatim.
function makeAsset(overrides: Partial<AnlaggningAsset> = {}): AnlaggningAsset {
  return {
    category: 'equipment',
    acquisition_date: '2024-01-01',
    acquisition_cost: 60_000,
    salvage_value: 0,
    useful_life_months: 60,
    disposed_at: null,
    figures: { ibAck: 0, aretsAvskrivning: 0, avgaendeAck: 0 },
    ...overrides,
  }
}

describe('buildAnlaggningstillgangarNote: roll-forward', () => {
  it('returns null when no assets fall in the period', () => {
    expect(
      buildAnlaggningstillgangarNote({
        noteNumber: 5,
        assets: [],
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      }),
    ).toBeNull()
  })

  it('writes a zero reduction as "0 kr", never "-0 kr"', () => {
    const note = buildAnlaggningstillgangarNote({
      noteNumber: 4,
      assets: [
        makeAsset({
          acquisition_date: '2025-06-01',
          figures: { ibAck: 0, aretsAvskrivning: 7_000, avgaendeAck: 0 },
        }),
      ],
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    })
    expect(note?.body).toContain('Ingående ackumulerade avskrivningar: 0 kr')
    expect(note?.body).toContain('Årets avskrivningar: \u22127 000 kr')
    expect(note?.body).not.toMatch(/[-\u2212]0 kr/)
  })

  // F3: the ÅRL 5:8 roll-forward headed a row with the raw category "land".
  it('heads mark\'s row "Mark", after Byggnader', () => {
    const note = buildAnlaggningstillgangarNote({
      noteNumber: 4,
      assets: [
        makeAsset({ category: 'land', useful_life_months: 0, acquisition_cost: 900_000 }),
        makeAsset({ category: 'building', useful_life_months: 600, acquisition_cost: 2_000_000 }),
      ],
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    })
    const heads = (note?.body ?? '').split('\n').filter((line) => line && !line.startsWith(' '))
    expect(heads.slice(0, 2)).toEqual(['Byggnader', 'Mark'])
    expect(note?.body).not.toMatch(/^land$/m)
  })

  it('skips assets disposed before the period', () => {
    const rows = _buildRollforwardForTests(
      [
        makeAsset({
          acquisition_date: '2020-01-01',
          acquisition_cost: 100_000,
          disposed_at: '2024-12-31',
          figures: { ibAck: 100_000, aretsAvskrivning: 0, avgaendeAck: 0 },
        }),
      ],
      PERIOD_START,
      PERIOD_END,
    )
    expect(rows).toEqual([])
  })

  it('records IB anskaffningsvärde and booked depreciation for assets acquired before the period', () => {
    const rows = _buildRollforwardForTests(
      [
        makeAsset({
          figures: { ibAck: 12_000, aretsAvskrivning: 12_000, avgaendeAck: 0 },
        }),
      ],
      PERIOD_START,
      PERIOD_END,
    )
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.ibAnskaffning).toBe(60_000)
    expect(r.tillkommande).toBe(0)
    expect(r.ubAnskaffning).toBe(60_000)
    expect(r.ibAck).toBe(12_000)
    expect(r.aretsAvskrivning).toBe(12_000)
    expect(r.ubAck).toBe(24_000)
    expect(r.ubRedovisat).toBe(36_000)
  })

  it('records tillkommande for assets acquired during the period without any IB ack', () => {
    const rows = _buildRollforwardForTests(
      [
        makeAsset({
          acquisition_date: '2025-07-01',
          figures: { ibAck: 999, aretsAvskrivning: 6_049, avgaendeAck: 0 },
        }),
      ],
      PERIOD_START,
      PERIOD_END,
    )
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.ibAnskaffning).toBe(0)
    expect(r.tillkommande).toBe(60_000)
    // ibAck only accrues for assets acquired before the period, even if the
    // upstream figure carried a nonzero value.
    expect(r.ibAck).toBe(0)
    expect(r.aretsAvskrivning).toBe(6_049)
  })

  it('records avgående and the reversed accumulated depreciation for in-period disposals', () => {
    const rows = _buildRollforwardForTests(
      [
        makeAsset({
          acquisition_date: '2023-01-01',
          disposed_at: '2025-06-30',
          figures: { ibAck: 24_000, aretsAvskrivning: 5_951, avgaendeAck: 29_951 },
        }),
      ],
      PERIOD_START,
      PERIOD_END,
    )
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.ibAnskaffning).toBe(60_000)
    expect(r.avgaende).toBe(60_000)
    expect(r.ubAnskaffning).toBe(0)
    expect(r.avgaendeAck).toBe(29_951)
    expect(r.ubAck).toBe(0)
    expect(r.ubRedovisat).toBe(0)
  })

  it('groups multiple assets in the same category', () => {
    const rows = _buildRollforwardForTests(
      [
        makeAsset({
          figures: { ibAck: 12_000, aretsAvskrivning: 12_000, avgaendeAck: 0 },
        }),
        makeAsset({
          acquisition_date: '2025-01-01',
          acquisition_cost: 40_000,
          figures: { ibAck: 0, aretsAvskrivning: 8_000, avgaendeAck: 0 },
        }),
      ],
      PERIOD_START,
      PERIOD_END,
    )
    expect(rows).toHaveLength(1)
    const r = rows[0]
    expect(r.ibAnskaffning).toBe(60_000)
    expect(r.tillkommande).toBe(40_000)
    expect(r.ubAnskaffning).toBe(100_000)
    expect(r.aretsAvskrivning).toBe(20_000)
    expect(r.ubAck).toBe(32_000)
  })

  it('separates categories', () => {
    const rows = _buildRollforwardForTests(
      [
        makeAsset({
          figures: { ibAck: 12_000, aretsAvskrivning: 12_000, avgaendeAck: 0 },
        }),
        makeAsset({
          category: 'computer',
          acquisition_cost: 20_000,
          useful_life_months: 36,
          figures: { ibAck: 6_667, aretsAvskrivning: 6_667, avgaendeAck: 0 },
        }),
      ],
      PERIOD_START,
      PERIOD_END,
    )
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.category === 'equipment')?.ibAnskaffning).toBe(60_000)
    expect(rows.find((r) => r.category === 'computer')?.ibAnskaffning).toBe(20_000)
  })

  it('emits a note with all expected lines when assets exist', () => {
    const note = buildAnlaggningstillgangarNote({
      noteNumber: 5,
      assets: [
        makeAsset({
          figures: { ibAck: 12_000, aretsAvskrivning: 12_000, avgaendeAck: 0 },
        }),
      ],
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    })
    expect(note).not.toBeNull()
    expect(note!.number).toBe(5)
    expect(note!.title).toBe('Anläggningstillgångar')
    expect(note!.body).toContain('Inventarier')
    expect(note!.body).toContain('Ingående anskaffningsvärde')
    expect(note!.body).toContain('Utgående anskaffningsvärde')
    expect(note!.body).toContain('Ingående ackumulerade avskrivningar')
    // sv-SE formatting uses a non-breaking thousands separator: build the
    // expected strings with the same formatter instead of literal spaces.
    const sv = (n: number) => n.toLocaleString('sv-SE')
    expect(note!.body).toContain(`Årets avskrivningar: \u2212${sv(12_000)} kr`)
    expect(note!.body).toContain(`Utgående redovisat värde: ${sv(36_000)} kr`)
  })

  it('passes upstream figures through verbatim without recomputing', () => {
    // Deliberately "impossible" figures for the asset's schedule: the
    // builder must not derive anything from cost/life/dates on its own.
    const rows = _buildRollforwardForTests(
      [
        makeAsset({
          figures: { ibAck: 1_234.56, aretsAvskrivning: 7_890.12, avgaendeAck: 0 },
        }),
      ],
      PERIOD_START,
      PERIOD_END,
    )
    expect(rows[0].ibAck).toBe(1_234.56)
    expect(rows[0].aretsAvskrivning).toBe(7_890.12)
    expect(rows[0].ubAck).toBe(9_124.68)
  })

  it('caps at the depreciable base only via upstream figures (fully depreciated asset)', () => {
    const rows = _buildRollforwardForTests(
      [
        makeAsset({
          acquisition_date: '2010-01-01',
          figures: { ibAck: 60_000, aretsAvskrivning: 0, avgaendeAck: 0 },
        }),
      ],
      PERIOD_START,
      PERIOD_END,
    )
    expect(rows[0].ibAck).toBe(60_000)
    expect(rows[0].aretsAvskrivning).toBe(0)
    expect(rows[0].ubAck).toBe(60_000)
    expect(rows[0].ubRedovisat).toBe(0)
  })
})

describe('computeRollforwardTotals', () => {
  it('sums closing book value and accumulated depreciation across categories', () => {
    const totals = computeRollforwardTotals(
      [
        makeAsset({
          figures: { ibAck: 12_000, aretsAvskrivning: 12_000, avgaendeAck: 0 },
        }),
        makeAsset({
          category: 'computer',
          acquisition_cost: 20_000,
          figures: { ibAck: 6_667, aretsAvskrivning: 6_667, avgaendeAck: 0 },
        }),
      ],
      PERIOD_START,
      PERIOD_END,
    )
    // equipment: 60,000 - 24,000 = 36,000; computer: 20,000 - 13,334 = 6,666
    expect(totals.ubAck).toBe(37_334)
    expect(totals.ubRedovisat).toBe(42_666)
  })
})

describe('depreciationPrinciples (the K2 Avskrivningar note)', () => {
  const lines = (assets: Parameters<typeof depreciationPrinciples>[0]) => depreciationPrincipleLines(depreciationPrinciples(assets))

  // F3: "• land: 0 år" under "Avskrivningar görs linjärt" reached the filed
  // K2 document.
  it('states that mark is not depreciated instead of listing it with 0 år', () => {
    expect(
      lines([
        { category: 'building', useful_life_months: 600, disposed_at: null },
        { category: 'land', useful_life_months: 0, disposed_at: null },
        { category: 'equipment', useful_life_months: 60, disposed_at: null },
      ]),
    ).toEqual([
      'Avskrivningar görs linjärt över bedömd nyttjandeperiod:',
      '• Byggnader: 50 år',
      '• Inventarier: 5 år',
      'Mark skrivs inte av.',
    ])
    expect(lines([{ category: 'land', useful_life_months: 0, disposed_at: null }])).toEqual(['Mark skrivs inte av.'])
    expect(lines([{ category: 'land', useful_life_months: 0, disposed_at: '2025-03-01' }])).toEqual([])
  })

  it('gives a category one row with the span of its periods, and leaves disposed assets out', () => {
    expect(
      depreciationPrinciples([
        { category: 'computer', useful_life_months: 36, disposed_at: null },
        { category: 'computer', useful_life_months: 60, disposed_at: null },
        { category: 'computer', useful_life_months: 120, disposed_at: '2025-03-01' },
      ]),
    ).toEqual({ rows: [{ label: 'Datorer', period: '3-5 år', post: null }], holdsLand: false })
  })

  describe('per balance sheet post', () => {
    const posts = {
      postOfAccount: (account: string) => (account < '1220' ? 'MaskinerAndraTekniskaAnlaggningar' : 'InventarierVerktygInstallationer'),
      labelOfPost: (post: string) => (post === 'MaskinerAndraTekniskaAnlaggningar' ? 'Maskiner och andra tekniska anläggningar' : 'Inventarier, verktyg och installationer'),
    }

    it('names the post each row is booked on', () => {
      expect(
        depreciationPrinciples(
          [
            { category: 'machinery', useful_life_months: 120, disposed_at: null, bas_asset_account: '1210' },
            { category: 'equipment', useful_life_months: 60, disposed_at: null, bas_asset_account: '1220' },
            { category: 'computer', useful_life_months: 36, disposed_at: null, bas_asset_account: '1250' },
          ],
          posts,
        ).rows,
      ).toEqual([
        { label: 'Maskiner', period: '10 år', post: 'MaskinerAndraTekniskaAnlaggningar' },
        { label: 'Inventarier', period: '5 år', post: 'InventarierVerktygInstallationer' },
        { label: 'Datorer', period: '3 år', post: 'InventarierVerktygInstallationer' },
      ])
    })

    it('splits a category booked on two posts into a row per post, each named with its post', () => {
      const principles = depreciationPrinciples(
        [
          { category: 'vehicle', useful_life_months: 60, disposed_at: null, bas_asset_account: '1215' },
          { category: 'vehicle', useful_life_months: 96, disposed_at: null, bas_asset_account: '1240' },
        ],
        posts,
      )
      expect(principles.rows).toEqual([
        { label: 'Fordon (Maskiner och andra tekniska anläggningar)', period: '5 år', post: 'MaskinerAndraTekniskaAnlaggningar' },
        { label: 'Fordon (Inventarier, verktyg och installationer)', period: '8 år', post: 'InventarierVerktygInstallationer' },
      ])
      expect(depreciationPrincipleLines(principles)).toEqual([
        'Avskrivningar görs linjärt över bedömd nyttjandeperiod:',
        '• Fordon (Maskiner och andra tekniska anläggningar): 5 år',
        '• Fordon (Inventarier, verktyg och installationer): 8 år',
      ])
    })

    it('keeps an asset without an account in a post as a row without one', () => {
      expect(
        depreciationPrinciples([{ category: 'equipment', useful_life_months: 60, disposed_at: null }], posts).rows,
      ).toEqual([{ label: 'Inventarier', period: '5 år', post: null }])
    })
  })

  it('tells a row of the text from its other lines', () => {
    expect(isDepreciationPrincipleRow('• Inventarier: 5 år')).toBe(true)
    expect(isDepreciationPrincipleRow('Avskrivningar görs linjärt över bedömd nyttjandeperiod:')).toBe(false)
    expect(isDepreciationPrincipleRow('Mark skrivs inte av.')).toBe(false)
  })
})

describe('buildAnlaggningstillgangarNote: write-downs (ÅRL 5:8 § p. 5)', () => {
  const movement = (over: Partial<{ opening: number; writtenDown: number; reversed: number; disposed: number; closing: number }>) => ({
    opening: 0,
    writtenDown: 0,
    reversed: 0,
    disposed: 0,
    closing: 0,
    ...over,
  })

  it('shows the year\'s write-down and reversal, and takes them off the redovisat värde', () => {
    const assets = [
      makeAsset({
        category: 'machinery',
        acquisition_cost: 200_000,
        figures: { ibAck: 40_000, aretsAvskrivning: 20_000, avgaendeAck: 0 },
        writeDowns: movement({ opening: 10_000, writtenDown: 30_000, reversed: 5_000, closing: 35_000 }),
      }),
    ]
    const note = buildAnlaggningstillgangarNote({ noteNumber: 4, assets, periodStart: PERIOD_START, periodEnd: PERIOD_END })
    expect(note?.body).toMatch(/Ingående ackumulerade nedskrivningar: \u221210\s000 kr/)
    expect(note?.body).toMatch(/Årets nedskrivningar: \u221230\s000 kr/)
    expect(note?.body).toMatch(/Årets återförda nedskrivningar: 5\s000 kr/)
    expect(note?.body).toMatch(/Utgående ackumulerade nedskrivningar: \u221235\s000 kr/)
    // 200 000 - 60 000 - 35 000
    expect(note?.body).toMatch(/Utgående redovisat värde: 105\s000 kr/)
    expect(computeRollforwardTotals(assets, PERIOD_START, PERIOD_END)).toMatchObject({ ubRedovisat: 105_000, ubNed: 35_000 })
    expect(holdsWriteDowns(assets)).toBe(true)
  })

  it('takes a disposed asset\'s write-downs off with it', () => {
    const note = buildAnlaggningstillgangarNote({
      noteNumber: 4,
      assets: [
        makeAsset({
          disposed_at: '2025-09-30',
          figures: { ibAck: 12_000, aretsAvskrivning: 9_000, avgaendeAck: 21_000 },
          writeDowns: movement({ opening: 8_000, disposed: 8_000 }),
        }),
      ],
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    })
    expect(note?.body).toMatch(/Återförda nedskrivningar på avgående: 8\s000 kr/)
    expect(note?.body).toMatch(/Utgående ackumulerade nedskrivningar: 0 kr/)
    expect(note?.body).toMatch(/Utgående redovisat värde: 0 kr/)
  })

  it('prints no write-down rows for a category without any', () => {
    const assets = [makeAsset({ writeDowns: movement({}) })]
    const note = buildAnlaggningstillgangarNote({ noteNumber: 4, assets, periodStart: PERIOD_START, periodEnd: PERIOD_END })
    expect(note?.body).not.toContain('nedskrivningar')
    expect(holdsWriteDowns(assets)).toBe(false)
  })
})
